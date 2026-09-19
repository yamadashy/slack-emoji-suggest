/**
 * The service worker: the only place that holds the API key and talks to the
 * ranking provider. The page and the content script never see the key.
 *
 * It keeps a small LRU of answers plus an in-flight map, so a hover-prefetch
 * followed by the picker opening on the same message costs one request, not
 * two. It also owns the stored set of workspace emoji: the content script
 * harvests them from the page, the worker merges and persists them.
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

/** Every request this worker answers, and the function behind it. */
const HANDLERS = {
  suggest: (msg) =>
    suggest(msg.key, msg.text).then((suggestions) => ({ suggestions, stats: suggestions.stats || null })),
  syncCustomEmoji: () => syncCustomEmoji(),
  mergeCustomEmoji: (msg) => mergeCustomEmoji(msg.emoji).then((count) => ({ count })),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  if (loadError) {
    sendResponse({ ok: false, error: `拡張機能の読み込みに失敗しました: ${loadError}` });
    return true;
  }
  handler(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err?.message || "不明なエラーです。" }),
  );
  return true; // keep the channel open for the async reply
});

try {
  importScripts("./candidates.js", "./providers/jev.js", "./providers/index.js");
} catch (err) {
  loadError = err?.message || String(err);
}

const { DEFAULT_CANDIDATES, EMOJI_GLYPHS, buildCandidates, chunkByBudget } = self.Candidates || {};
const { DEFAULT_PROVIDER, getProvider } = self.ProviderRegistry || {};

const CACHE_MAX = 50;

/** key -> {shortcode, glyph, url, p}[]. Insertion order is the LRU order. */
const cache = new Map();
/** key -> Promise of the same, for requests that have not landed yet. */
const inflight = new Map();

/* ---------------------------------------------------------------- suggest */

async function suggest(key, text) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert to mark as most recently used
    cache.set(key, hit);
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = rankMessage(text);
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

async function rankMessage(text) {
  const settings = await chrome.storage.local.get([
    "provider",
    "apiKeys",
    "candidates",
    "customEmoji",
    "customEmojiDescriptions",
  ]);
  const providerId = settings.provider || DEFAULT_PROVIDER;
  const apiKey = settings.apiKeys?.[providerId];
  if (!apiKey) throw new Error("API キーが未設定です。拡張機能の設定で登録してください。");

  const built = buildCandidates({
    standardText: settings.candidates,
    customEmoji: settings.customEmoji || [],
    customDescriptionsText: settings.customEmojiDescriptions || "",
  });
  if (built.error) throw new Error(built.error);

  const urls = new Map(built.candidates.map((c) => [c.shortcode, c.url]));
  const provider = getProvider(providerId);

  // One request is the common case; a workspace with hundreds of emoji gets
  // several in parallel. Each chunk is independent -- the scores are per-emoji
  // and never normalised across the set -- so merging is just concatenation.
  const chunks = chunkByBudget(built.candidates);
  const started = Date.now();
  const results = await Promise.all(
    chunks.map((candidates) => provider.rank({ message: text, candidates, apiKey })),
  );

  const ranked = results
    .flat()
    .sort((a, b) => b.p - a.p)
    .map((r) => ({
      ...r,
      // List metadata, not model output: attached here so the content script
      // stays a dumb renderer. A workspace emoji has a url, a standard one a glyph.
      glyph: EMOJI_GLYPHS[r.shortcode] || null,
      url: urls.get(r.shortcode) || null,
    }));

  // What the request actually cost, for the options page and for tuning the
  // split. Hung off the array so the cached value carries it too.
  ranked.stats = {
    candidates: built.candidates.length,
    requests: chunks.length,
    ms: Date.now() - started,
    inputTokens: results.reduce((n, r) => n + (r.usage?.input_tokens || 0), 0),
    outputTokens: results.reduce((n, r) => n + (r.usage?.output_tokens || 0), 0),
  };
  return ranked;
}

/* ----------------------------------------------------------- custom emoji */

/** Merge harvested emoji into storage; returns the new total. Site-neutral:
 *  the worker never learns how they were found. */
async function mergeCustomEmoji(emoji) {
  if (!Array.isArray(emoji) || emoji.length === 0) {
    const { customEmoji } = await chrome.storage.local.get("customEmoji");
    return (customEmoji || []).length;
  }
  const { customEmoji } = await chrome.storage.local.get("customEmoji");
  const merged = new Map((customEmoji || []).map((e) => [e.name, e.url]));
  for (const e of emoji) if (e?.name) merged.set(e.name, e.url || null);
  const list = [...merged].map(([name, url]) => ({ name, url }));
  await chrome.storage.local.set({ customEmoji: list });
  return list.length;
}

/**
 * Ask the open chat tab to walk its emoji picker.
 *
 * The worker cannot touch a page, so the harvesting itself lives in the
 * content script's site adapter; this only routes the request and stores what
 * comes back.
 */
async function syncCustomEmoji() {
  const tabs = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  if (tabs.length === 0) throw new Error("Slack のタブが見つかりません。Slack を開いてから実行してください。");

  let lastError = "カスタム絵文字を取り込めませんでした。";
  for (const tab of tabs) {
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "collectCustomEmoji" });
    } catch {
      lastError = "Slack のタブに接続できませんでした。タブを再読み込みしてください。";
      continue;
    }
    if (!res?.ok) {
      lastError = res?.error || lastError;
      continue;
    }
    const count = await mergeCustomEmoji(res.emoji);
    const syncedAt = Date.now();
    await chrome.storage.local.set({ customEmojiSyncedAt: syncedAt });
    return { count, found: res.emoji.length, ms: res.ms, passes: res.passes, syncedAt };
  }
  throw new Error(lastError);
}
