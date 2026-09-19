/**
 * The service worker: the only place that holds the API key and talks to the
 * ranking provider. The page and the content script never see the key.
 *
 * It answers exactly one message, `suggest`, and keeps a small LRU of answers
 * plus an in-flight map, so a hover-prefetch followed by the picker opening on
 * the same message costs one request, not two.
 *
 * A classic worker, not a module one: importScripts() is synchronous, so the
 * shared files are in place within the worker's first turn.
 *
 * Two things about the ordering below are deliberate, and both were bugs first:
 *
 * - The listener is registered before anything that can fail. An MV3 worker is
 *   started *by* the message it has to answer; if the top of the script throws,
 *   the listener never exists and the page only ever sees "the extension did
 *   not answer". Registering first turns any load failure into a sentence the
 *   user can act on.
 * - The listener must return `true` synchronously to keep the reply channel
 *   open, so the async work is kicked off and its result posted back later.
 */

/** Set if the shared files could not be loaded; reported instead of an answer. */
let loadError = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "suggest") return false;
  if (loadError) {
    sendResponse({ ok: false, error: `拡張機能の読み込みに失敗しました: ${loadError}` });
    return true;
  }
  suggest(msg.key, msg.text).then(
    (suggestions) => sendResponse({ ok: true, suggestions }),
    (err) => sendResponse({ ok: false, error: err?.message || "不明なエラーです。" }),
  );
  return true; // keep the channel open for the async reply
});

try {
  importScripts("./candidates.js", "./providers/jev.js", "./providers/index.js");
} catch (err) {
  loadError = err?.message || String(err);
}

const { DEFAULT_CANDIDATES, EMOJI_GLYPHS, parseCandidates } = self.Candidates || {};
const { DEFAULT_PROVIDER, getProvider } = self.ProviderRegistry || {};

const CACHE_MAX = 50;

/** key -> {shortcode, glyph, p}[]. Insertion order is the LRU order. */
const cache = new Map();
/** key -> Promise of the same, for requests that have not landed yet. */
const inflight = new Map();

async function suggest(key, text) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert to mark as most recently used
    cache.set(key, hit);
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const settings = await chrome.storage.local.get(["provider", "apiKeys", "candidates"]);
    const providerId = settings.provider || DEFAULT_PROVIDER;
    const apiKey = settings.apiKeys?.[providerId];
    if (!apiKey) throw new Error("API キーが未設定です。拡張機能の設定で登録してください。");

    const parsed = parseCandidates(settings.candidates || DEFAULT_CANDIDATES);
    if (parsed.error) throw new Error(`候補リストが読めません: ${parsed.error}`);

    const ranked = await getProvider(providerId).rank({
      message: text,
      candidates: parsed.candidates,
      apiKey,
    });
    // The glyph is list metadata, not a model output, so it is attached here
    // and the content script stays a dumb renderer.
    return ranked.map((r) => ({ ...r, glyph: EMOJI_GLYPHS[r.shortcode] || null }));
  })();

  inflight.set(key, p);
  try {
    const result = await p;
    cache.set(key, result);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return result;
  } finally {
    inflight.delete(key);
  }
}
