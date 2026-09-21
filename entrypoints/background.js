/**
 * The service worker: the only place that holds the API key and talks to the
 * ranking provider. The page and the content script never see the key.
 *
 * It keeps a small LRU of answers plus an in-flight map, so a hover-prefetch
 * followed by the picker opening on the same message costs one request, not
 * two. It also owns the stored set of workspace emoji: the content script
 * harvests them from the page, the worker merges and persists them.
 *
 * One thing about the listener below is deliberate, and it was a bug first: it
 * must return `true` synchronously to keep the reply channel open, so the async
 * work is kicked off and its result posted back later.
 */
import { defineBackground } from "wxt/utils/define-background";
import { t } from "@/utils/i18n.js";
import { EMOJI_GLYPHS, buildCandidates, chunkByBudget, markNameMatches } from "@/utils/candidates.js";
import { DEFAULT_PROVIDER, getProvider } from "@/utils/providers/index.js";

/** Every request this worker answers, and the function behind it. */
const HANDLERS = {
  suggest: (msg) =>
    suggest(msg.key, msg.text, msg.context, msg.workspace).then((suggestions) => ({
      suggestions,
      stats: suggestions.stats || null,
    })),
  syncCustomEmoji: () => syncCustomEmoji(),
  mergeCustomEmoji: (msg) => mergeCustomEmoji(msg.workspace, msg.emoji, msg.full).then((r) => r),
  /** Newly learned emoji make a cached ranking stale. */
  invalidate: (msg) => {
    cache.delete(msg.key);
    return Promise.resolve({});
  },
  /** "Does this workspace still need a full walk?" -- asked on every load. */
  workspaceState: (msg) =>
    readWorkspace(msg.workspace).then((w) => ({ count: w.emoji.length, syncedAt: w.syncedAt, fresh: isFresh(w) })),
  /** Why an automatic attempt could not run, so the popup can explain itself. */
  recordHarvest: (msg) => recordHarvest(msg.workspace, msg.error),

  /* ------------------------------------------------------ popup-facing --- */
  getStatus: () => getStatus(),
  setEnabled: (msg) => setEnabled(msg.workspace, msg.enabled),
  /** Write-only: there is deliberately no handler that returns the key. */
  setApiKey: (msg) => setApiKey(msg.key),
  clearApiKey: () => clearApiKey(),
  harvestNow: () => syncCustomEmoji(),

  /**
   * Open the settings, which are the toolbar popup. `openPopup` refuses when
   * the window is not focused or the Chrome is too old to allow it without a
   * gesture of its own, so the same page in a tab is the fallback.
   */
  openSettings: (_msg, sender) =>
    chrome.action
      .openPopup(sender?.tab?.windowId ? { windowId: sender.tab.windowId } : undefined)
      .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }))
      .then(() => ({})),
};

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg?.type];
    if (!handler) return false;
    handler(msg, sender).then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: err?.message || t("errUnknown"), code: err?.code || null }),
    );
    return true; // keep the channel open for the async reply
  });
});

const CACHE_MAX = 50;
/** A full harvest older than this is worth redoing. */
const FRESH_FOR_MS = 24 * 60 * 60 * 1000;
/** Where per-workspace emoji live: {[workspaceId]: {emoji, syncedAt, full}}. */
const STORE = "customEmojiByWorkspace";

/** key -> {shortcode, glyph, url, p}[]. Insertion order is the LRU order. */
const cache = new Map();
/** key -> Promise of the same, for requests that have not landed yet. */
const inflight = new Map();

/* ---------------------------------------------------------------- suggest */

async function suggest(key, text, context, workspace) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert to mark as most recently used
    cache.set(key, hit);
    return hit;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = rankMessage(text, context, workspace);
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

async function rankMessage(text, context, workspace) {
  const settings = await chrome.storage.local.get([
    "provider",
    "apiKeys",
    "candidates",
    "customEmojiDescriptions",
  ]);
  const providerId = settings.provider || DEFAULT_PROVIDER;
  const apiKey = settings.apiKeys?.[providerId];
  if (!apiKey) {
    // `code` lets the row turn this one into a link to the settings; every
    // other error is just a sentence.
    throw Object.assign(new Error(t("errNoApiKey")), { code: "no_api_key" });
  }

  // Strictly this workspace's emoji. Another workspace's are irrelevant here
  // and suggesting them would leak one workspace's vocabulary into another.
  const { emoji } = await readWorkspace(workspace);

  const built = buildCandidates({
    standardText: settings.candidates,
    customEmoji: emoji,
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
    chunks.map((candidates) => provider.rank({ message: text, context, candidates, apiKey })),
  );

  const scored = results
    .flat()
    .sort((a, b) => b.p - a.p)
    .map((r) => ({
      ...r,
      // List metadata, not model output: attached here so the content script
      // stays a dumb renderer. A workspace emoji has a url, a standard one a glyph.
      glyph: EMOJI_GLYPHS[r.shortcode] || null,
      url: urls.get(r.shortcode) || null,
    }));

  // A name the message actually said beats anything the model thought. Done
  // here, on text the worker already has, so it costs no extra request.
  const ranked = markNameMatches(scored, text);

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

/**
 * Read one workspace's emoji.
 *
 * Keyed by workspace because the owner keeps several open at once, and one
 * workspace's vocabulary must never be suggested in another. The pre-0.3
 * un-keyed `customEmoji` key is simply not read: it has no workspace attached,
 * so there is no safe workspace to attribute it to, and a fresh harvest costs
 * a few seconds. It is left in storage rather than deleted, in case it is ever
 * worth looking at.
 */
async function readWorkspace(workspace) {
  const empty = { emoji: [], syncedAt: null, full: false, lastError: null, attempts: 0 };
  if (!workspace) return empty;
  const store = (await chrome.storage.local.get(STORE))[STORE] || {};
  const entry = store[workspace];
  if (!entry) return empty;
  return {
    emoji: entry.emoji || [],
    syncedAt: entry.syncedAt || null,
    full: !!entry.full,
    lastError: entry.lastError || null,
    attempts: entry.attempts || 0,
  };
}

/** Remember why an automatic attempt did not happen, and how many have failed. */
async function recordHarvest(workspace, error) {
  if (!workspace) return {};
  const store = (await chrome.storage.local.get(STORE))[STORE] || {};
  const entry = store[workspace] || { emoji: [], syncedAt: null, full: false };
  store[workspace] = {
    ...entry,
    lastError: error || null,
    lastErrorAt: error ? Date.now() : entry.lastErrorAt || null,
    attempts: (entry.attempts || 0) + 1,
  };
  await chrome.storage.local.set({ [STORE]: store });
  return {};
}

/**
 * Merge harvested emoji into one workspace's set.
 *
 * `full` marks the result of a complete walk of the custom tab, as opposed to
 * the opportunistic scraps picked up from an open picker. Only a full harvest
 * refreshes `syncedAt`, so partial learning can never make a stale set look
 * freshly synced. Site-neutral: the worker never learns how they were found.
 */
async function mergeCustomEmoji(workspace, emoji, full = false) {
  if (!workspace) throw new Error(t("errWorkspaceUnknown"));
  const store = (await chrome.storage.local.get(STORE))[STORE] || {};
  const entry = store[workspace] || { emoji: [], syncedAt: null, full: false };

  const merged = new Map((entry.emoji || []).map((e) => [e.name, e.url]));
  const before = merged.size;
  for (const e of emoji || []) if (e?.name) merged.set(e.name, e.url || null);

  const list = [...merged].map(([name, url]) => ({ name, url }));
  const added = list.length - before;
  // Nothing new and nothing to promote: skip the write entirely, so the
  // opportunistic path costs nothing on a picker the user just reopens.
  if (added === 0 && !full) return { count: list.length, added: 0, syncedAt: entry.syncedAt };

  store[workspace] = {
    emoji: list,
    syncedAt: full ? Date.now() : entry.syncedAt,
    full: entry.full || full,
  };
  await chrome.storage.local.set({ [STORE]: store });
  return { count: list.length, added, syncedAt: store[workspace].syncedAt };
}

/**
 * Ask a chat tab to walk its emoji picker, on the user's explicit request.
 *
 * The worker cannot touch a page, so the walk itself lives in the content
 * script; this routes the request. Two things make it honest rather than
 * hanging: the tab is brought to the foreground first (a background tab does
 * not paint, so the virtualised grid renders nothing and the harvest silently
 * comes back empty -- the original bug), and every wait has a deadline.
 */
async function syncCustomEmoji() {
  const tabs = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  if (tabs.length === 0) throw new Error(t("errNoSlackTab"));

  const tab = tabs.find((t) => t.active) || tabs[0];
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* focusing is best-effort; the harvest below will fail loudly if it mattered */
  }
  // Give the tab a moment to actually become visible and paint a frame.
  await new Promise((r) => setTimeout(r, 400));

  let res;
  try {
    res = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "collectCustomEmoji", hidden: true }),
      45000,
    );
  } catch (err) {
    if (err?.message === "timeout") throw new Error(t("errHarvestTimeout"));
    throw new Error(t("errReloadSlackTab"));
  }
  if (!res) throw new Error(t("errReloadSlackTab"));
  if (!res.ok) throw new Error(res.error || t("errHarvestFailed"));

  const merged = await mergeCustomEmoji(res.workspace, res.emoji, true);
  return {
    workspace: res.workspace,
    count: merged.count,
    found: res.emoji.length,
    ms: res.ms,
    passes: res.passes,
    syncedAt: merged.syncedAt,
  };
}

/* ------------------------------------------------------------- the popup */

/** Which workspaces the user has switched off. Absent means on. */
const ENABLED = "workspaceEnabled";

async function isEnabled(workspace) {
  if (!workspace) return true;
  const map = (await chrome.storage.local.get(ENABLED))[ENABLED] || {};
  return map[workspace] !== false;
}

async function setEnabled(workspace, enabled) {
  if (!workspace) return {};
  const map = (await chrome.storage.local.get(ENABLED))[ENABLED] || {};
  map[workspace] = !!enabled;
  await chrome.storage.local.set({ [ENABLED]: map });
  return {};
}

/** Forget the key, and the rankings it paid for -- "deleted" should mean the
 *  extension stops suggesting, not that it coasts on its cache. */
async function clearApiKey() {
  const { provider, apiKeys } = await chrome.storage.local.get(["provider", "apiKeys"]);
  const rest = { ...(apiKeys || {}) };
  delete rest[provider || DEFAULT_PROVIDER];
  await chrome.storage.local.set({ apiKeys: rest });
  cache.clear();
  return {};
}

async function setApiKey(key) {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error(t("errKeyEmpty"));
  const { provider, apiKeys } = await chrome.storage.local.get(["provider", "apiKeys"]);
  const providerId = provider || DEFAULT_PROVIDER;
  await chrome.storage.local.set({
    provider: providerId,
    apiKeys: { ...(apiKeys || {}), [providerId]: trimmed },
  });
  return {};
}

/**
 * Everything the popup shows, in one round trip.
 *
 * The workspace comes from whichever supported tab is in front, asked of the
 * content script rather than parsed here -- URL shapes are the site adapter's
 * business. A tab with no content script (opened before the extension was
 * installed, or not Slack at all) just yields a null workspace, which the
 * popup renders as a friendly one-liner.
 */
async function getStatus() {
  const { apiKeys, provider } = await chrome.storage.local.get(["apiKeys", "provider"]);
  const hasKey = !!apiKeys?.[provider || DEFAULT_PROVIDER];
  const base = {
    workspace: null,
    workspaceName: null,
    enabled: true,
    emoji: [],
    count: 0,
    syncedAt: null,
    lastError: null,
    hasKey,
  };

  // Prefer the tab in front, then any chat tab in this window, then any at all.
  //
  // Without the broad "tabs" permission Chrome hides the URL of tabs the
  // extension has no host permission for, so "the active tab" is often just a
  // blank -- there is no way to tell a work intranet from the popup's own
  // debug tab. Falling back to an open chat tab is both the only thing that
  // works and the more useful answer: if Slack is open in this window, showing
  // its workspace beats shrugging.
  const isChat = (t) => /^https:\/\/app\.slack\.com\//.test(t?.url || "");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = isChat(active)
    ? active
    : (await chrome.tabs.query({ url: "https://app.slack.com/*", currentWindow: true }))[0] ||
      (await chrome.tabs.query({ url: "https://app.slack.com/*" }))[0];
  if (!tab?.id) return base;

  let info;
  try {
    info = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "siteInfo" }), 2000);
  } catch {
    return base; // no content script in that tab; nothing to say about it
  }
  if (!info?.workspace) return base;

  const entry = await readWorkspace(info.workspace);
  return {
    ...base,
    workspace: info.workspace,
    workspaceName: info.workspaceName || null,
    enabled: await isEnabled(info.workspace),
    emoji: entry.emoji,
    count: entry.emoji.length,
    syncedAt: entry.syncedAt,
    lastError: entry.lastError,
  };
}

/** Reject with `timeout` rather than hanging forever on an unanswered tab. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/** Whether this workspace has had a complete walk recently enough to skip one. */
function isFresh(entry) {
  return !!(entry.full && entry.syncedAt && Date.now() - entry.syncedAt < FRESH_FOR_MS);
}
