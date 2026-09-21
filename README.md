# Slack Emoji Suggest

A Chrome extension that suggests emoji reactions for a Slack message, including your workspace's custom emoji.

Hover a message, open the reaction picker, and up to nine suggestions appear above the emoji list, one click away. Ranking is done by [TypeSafe](https://typesafe.ai)'s Jev model.

<!-- screenshot: the suggestion row inside Slack's emoji picker -->

## 🚀 Install

Not on the Chrome Web Store yet, so it is loaded from a zip.

1. Download [slack-emoji-suggest.zip](https://github.com/yamadashy/slack-emoji-suggest/releases/latest/download/slack-emoji-suggest.zip).
2. Open `chrome://extensions`, turn on Developer mode, and drag the zip onto the page. (Or unzip it and choose **Load unpacked**.)
3. Click the toolbar icon and paste a TypeSafe API key into the popup.
4. Open Slack in the browser (not the desktop app) and hover a message.

To update, download the new zip and drag it onto `chrome://extensions` again.

## 🔒 Privacy

- The text of the message you point at, plus up to three messages just before it, is sent to `api.typesafe.ai` for ranking. Nothing is sent in the background.
- The API key stays in `chrome.storage.local` and is read only by the service worker.
- Custom emoji are read from the page and never uploaded.

## 💻 Development

Built with [WXT](https://wxt.dev). Nothing built is committed.

```sh
npm ci
npm run dev     # launches Chrome with the extension loaded, and reloads on edit
npm run build   # writes .output/chrome-mv3/
npm run zip     # writes .output/slack-emoji-suggest-<version>-chrome.zip
```

`npm run dev` is the usual loop. For a plain build, load `.output/chrome-mv3/` with **Load unpacked**, and after changing the extension reload it on `chrome://extensions` and reload the Slack tab.

A release is cut by bumping `version` in `package.json` and pushing to main.
