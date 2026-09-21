/**
 * Tiny i18n helper shared by every classic script (the service worker and the
 * content scripts), none of which have `import`. Falls back to the key
 * itself so a mistyped id is visible on screen rather than blank.
 *
 * Loaded first everywhere a localized string is used: first entry of the
 * manifest's content script `js` array, and the first argument of
 * `importScripts()` in background.js.
 */
self.t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
