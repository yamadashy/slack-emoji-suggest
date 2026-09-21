# Slack Emoji Suggest

A Chrome extension that suggests emoji reactions for a Slack message, including your workspace's custom emoji.

Hover a message, open the reaction picker, and up to nine suggestions appear above the emoji list, one click away. Ranking is done by [TypeSafe](https://typesafe.ai)'s Jev model.

<!-- screenshot: the suggestion row inside Slack's emoji picker -->

## 🚀 Install

Not on the Chrome Web Store yet, so it is loaded from a zip.

1. Download [slack-emoji-suggest.zip](https://github.com/yamadashy/slack-emoji-suggest/releases/latest/download/slack-emoji-suggest.zip) and unzip it.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select the unzipped `slack-emoji-suggest` folder.
3. Click the toolbar icon and paste a TypeSafe API key into the popup.
4. Open Slack in the browser (not the desktop app) and hover a message.

To update, download the zip again, replace the folder, and press the reload button on `chrome://extensions`.

## 🔒 Privacy

- The text of the message you point at, plus up to three messages just before it, is sent to `api.typesafe.ai` for ranking. Nothing is sent in the background.
- The API key stays in `chrome.storage.local` and is read only by the service worker.
- Custom emoji are read from the page and never uploaded.

## 💻 Development

Everything under `extension/src/` is plain JavaScript, loaded unbuilt. Only the popup is built:

```sh
cd popup
npm ci
npm run dev     # browser preview, chrome.* is mocked
npm run build   # writes extension/popup/ — commit the result
```

To work from a clone, load the `extension/` directory with **Load unpacked** instead. After changing the extension, reload it on `chrome://extensions` and reload the Slack tab.
