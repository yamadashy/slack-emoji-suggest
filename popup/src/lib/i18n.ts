/**
 * The popup's translation helper.
 *
 * `chrome.i18n` is available when this runs as the real popup, but `npm run
 * dev` renders it in a plain browser tab (see bridge.ts's `hasChrome` mock
 * path), where there is no `chrome.*` at all. The fallback below reads the
 * same messages.json files the extension ships, picked by the browser's own
 * language -- close enough for local iteration, and it costs nothing in the
 * production bundle since Vite folds it into the JS the popup already ships.
 */
import en from "../../../extension/_locales/en/messages.json";
import ja from "../../../extension/_locales/ja/messages.json";

type MessagesFile = Record<string, { message: string }>;

const hasChromeI18n = typeof chrome !== "undefined" && !!chrome.i18n?.getMessage;

const fallbackMessages: MessagesFile = (navigator.language || "").toLowerCase().startsWith("ja")
  ? (ja as MessagesFile)
  : (en as MessagesFile);

/** Messages use Chrome's positional `$1`..`$9`; the local fallback does the
 *  same substitution so both paths read identically. */
function substitute(message: string, subs: string[]): string {
  return message.replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? "");
}

export function t(key: string, subs?: string | number | (string | number)[]): string {
  const substitutions = subs == null ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);

  if (hasChromeI18n) {
    const message = chrome.i18n.getMessage(key, substitutions.length ? substitutions : undefined);
    if (message) return message;
  }

  const entry = fallbackMessages[key];
  if (!entry) return key;
  return substitutions.length ? substitute(entry.message, substitutions) : entry.message;
}
