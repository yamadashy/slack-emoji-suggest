/**
 * Tiny i18n helper shared by the service worker and the content script. Falls
 * back to the key itself so a mistyped id is visible on screen rather than
 * blank.
 */
export const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
