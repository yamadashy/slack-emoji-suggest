# Slack Emoji Suggest

A Chrome extension that suggests emoji reactions for a Slack message, including
your workspace's own custom emoji. Hover a message and the extension asks a
model to score every candidate emoji; open the reaction picker and the top nine
appear as their own section pinned above the emoji list, over
「よく使う絵文字」, one click away. The interesting part is
the custom emoji: a workspace's `:shipit:`, `:repomix:` or `:claude-code:` are
usually the ones people actually reach for, and they are learned from Slack's
own UI rather than from any API.

Ranking is done by [TypeSafe](https://typesafe.ai)'s Jev model, but the model
sits behind a one-function boundary and is meant to be swappable.

<!-- screenshot: the おすすめ row inside Slack's emoji picker -->

Status: a working prototype the author uses daily. Not published to the Chrome
Web Store. No license yet.

## Install

1. Clone the repo. No build step is required — the popup's build output is
   committed.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**
   and select the `extension/` directory.
3. Click the toolbar icon and paste a TypeSafe API key into the popup. The key
   is stored in `chrome.storage.local` and is only ever read by the service
   worker.
4. Open Slack in the browser (not the desktop app — see Known limits) and hover
   a message.

The extension ships a `key` in its manifest, so the extension ID is stable at
`alemihiajbabhgfdgogganjphfkppeek` no matter where the folder lives. The private
half is deliberately outside the repo at
`~/.local/state/slack-emoji-suggest/key.pem` and must stay there.

## How it works

Nothing knows about more than one thing. One file knows Slack's DOM, one file
knows the ranking model, and the layer in between knows neither.

| Path | Responsibility |
| --- | --- |
| `extension/src/sites/slack.js` | The only file that knows Slack's DOM: selectors, hover and picker detection, custom-emoji harvesting, performing a reaction |
| `extension/src/content.js` | Site-neutral: debounce, cache, rendering the suggestion row, threshold and count |
| `extension/src/providers/jev.js` | The only file that knows Jev: endpoint, question wording, reading answers |
| `extension/src/providers/index.js` | Picks the provider. Only `jev` exists today |
| `extension/src/background.js` | The only holder of the API key. LRU cache, request de-duplication, custom-emoji storage |
| `extension/src/candidates.js` | Candidate list and parser, merging custom with standard, name matching, request splitting |
| `popup/` → `extension/popup/` | Toolbar popup. React + Tailwind + shadcn/ui. The only part with a build |

### Suggesting

1. When the pointer rests on a message for **250 ms**, its text — plus the few
   messages rendered just before it, as context — is sent to the service worker
   and ranked ahead of time. Sweeping the mouse down a channel
   fires nothing.
2. The click on the toolbar's "リアクションを追加..." button is caught in the
   **capture phase**, which is the only chance to learn which message the picker
   is about to belong to — Slack gives the picker no link back to its message.
3. When the picker appears, a section titled 「Slack Emoji Suggest によるおすすめ」
   is pinned above the emoji list, over 「よく使う絵文字」. If
   the prefetch has landed it paints immediately, otherwise it shows
   placeholders. See [Where the section goes](#where-the-section-goes).
4. Clicking a suggestion types the shortcode into **the picker's own search
   box** and clicks the single match. The grid is virtualised, so an emoji that
   is not scrolled into view has no DOM node to click; going through the search
   guarantees one exists. No Slack API tokens are involved anywhere.

Selectors live in one `SEL` object and are all `data-qa` attributes or ARIA
roles, never hashed class names — `data-qa` is what Slack's own end-to-end tests
use, so it changes less often. Note the inconsistency: the dialog is
`data-qa="emoji-picker"` with a hyphen while the button is `add_reaction` with
an underscore.

No MutationObserver is left running. One is attached to `body` only for the few
hundred milliseconds between the button click and the picker appearing, then
disconnected. Hover uses a single delegated listener, because Slack recycles
message rows as you scroll and per-row handlers leak.

### Where the section goes

The suggestions are their own section — own heading, own row of emoji — pinned
above the picker's list, so the order reads: ours → 「よく使う絵文字」 →
「スマイリー & 人」 → … Nothing is merged into or appended to Slack's
frequently-used section. It does not scroll with the list, and a faint tint and
hairline mark it as a band of its own rather than a section that forgot to move.

Mechanically it is one `div` laid over the top of the picker's list container,
with CSS moving Slack's list and pinned heading down by its height, 62px. The
container already clips, so the list's last 62px would fall out of sight; a
62px spacer after the scroller's content gives the scroll range back. No React
internals are touched and no handler of Slack's is wrapped; a Slack change can
at worst leave the node unplaced.

#### Why it is not simply inserted into the list

The obvious implementation is an extra node in front of the grid, inside the
scroll container, growing the scrollable range by its own height. That was the
implementation up to 0.5.1, and it was wrong.

react-virtualized renders only the rows it believes are on screen, worked out
from `scrollTop` alone. A node in front of the grid pushes every row down by its
height without telling the library, so at any scroll position past the top, the
first 62px of the viewport was covered by rows it had already unmounted.
Measured on the live picker: at `scrollTop` 60 the 「よく使う絵文字」 heading and
its emoji were on screen; at 62 they were gone, with a 62px hole in their place.
Rolling the wheel made the section blink in and out — that was the real bug
behind "「よく使う絵文字」 moves up and down when I scroll". Overscan does not save
it, because react-virtualized only overscans in the direction of travel:
scrolling down, it trims the top immediately. Slack's pinned heading reads the
same `scrollTop`, which is why it also named the next section 62px early.

Moving the list as a whole instead of the content inside it leaves `scrollTop`
meaning what it has always meant, so every row the library renders stays inside
the visible area, and the pinned heading is right again.

#### Why it does not scroll away

An earlier version slid the scroll viewport up as the section left, with a
scroll-driven animation over the first 62px. That keeps the library honest but
the viewport and the content inside it then both move by `scrollTop`: the list
travels at twice the wheel's speed, and the first section is eaten by the
pinned heading while ours is still half on screen. Content at 1x needs a
viewport that stays put, and a viewport that stays put needs a section that
does. Stepping out of the way on the first scroll was tried as well; the list
jumping 62px under the pointer felt wrong. Pinned and tinted is what is left.

Two details are load-bearing:

- **It keys off the section's own node**, via `:has()`, not off a class on the
  picker. A class was tried: Slack rewrites the picker's whole `className` when
  a category tab is clicked, and defending it with a MutationObserver watching
  `class` across the subtree span the renderer at 100% CPU.
- **The list is matched as a descendant of the container, not a child.** Slack
  sometimes wraps it in a `.p-autoclog__hook` div with no box of its own; a
  child selector then moved the pinned heading alone, onto the next section's
  heading.

The category tabs **filter** the list rather than scroll to an offset — each tab
replaces the content and resets `scrollTop` — so the section stays at the top of
whichever category is shown, including the custom tab.

**Height is reserved in CSS**, not derived from content. 62px, fixed from the
first frame, so an answer arriving or failing never moves anything.

While the search box has a query Slack replaces the list with results, so the
section hides itself; `hidden` is the same switch the CSS reads, so Slack's list
and pinned heading go straight back where Slack put them. Clearing the query
brings both back. Hiding is safe mid-click — `react()` types into that same box,
but the shortcode has already been read off the button by then.

A picker-scoped MutationObserver re-seats the node if Slack re-renders the list
out from under it. It moves the same node rather than recreating one, so there
is no flicker and never a duplicate, and it is torn down with the dialog — there
is no permanent observer on `body`.

One deliberate limitation: our buttons do not carry Slack's
`data-qa="emoji_list_item"`, so Slack's arrow-key grid navigation walks its own
cells and never enters our section. That also keeps the harvest from collecting
our own images as workspace emoji. The buttons are still reachable by Tab.

### Ranking rule

Each candidate is scored independently (a per-emoji yes/no probability rather
than one distribution over all of them, so several can score high at once). The
row shows the top nine — one full row of Slack's grid — dropping anything below
**0.5**.

The few messages rendered just before the target (three, or a thread's parent
plus its latest replies) go along as `state.context`, with an instruction to
use them for topic and mood but judge the reaction to the message itself.
Measured on 「今日中に終わらせます」: after a release announcement `:tada:` goes
0.26 → 0.44 and `:muscle:` 0.65 → 0.83; after an outage apology `:tada:` drops
to 0.07, `:sob:` rises 0.09 → 0.42 and `:+1:` falls 0.72 → 0.36.

0.5 rather than the 0.8 that ordinary work updates suggest: a message like
"本番環境へのデプロイが完了しました。エラーは出ていません。" scores `:ship:` 0.96 and
`:white_check_mark:` 0.93, but a one-line idea memo tops out around 0.65, and an
0.8 floor shows nothing at all on that kind of channel.

### Name matching

If the message text says an emoji's name, that emoji leads the row whatever the
model thought, and skips the score floor. "Claude Codeの絵文字つけてほしい" has to
put `:claude-code:` first. This is a string match on text the worker already
has — nothing extra is sent to the model.

Both sides are normalised the same way (NFKC, lowercased, `-` and `_` treated as
spaces) and compared two ways:

- **spaced**, requiring a non-alphanumeric boundary for ASCII names, which is
  what stops `:pig:` firing inside "config". Japanese characters are not
  alphanumeric, so 「Claude Codeの絵文字」 still matches despite the trailing の.
- **tight**, separators removed, so "ClaudeCode" matches `:claude-code:`. There
  is no boundary to check in this form, so it is allowed only for names that
  contain a separator — those are long and specific enough that a chance
  substring hit is not a real risk.

Names shorter than three characters are ignored. When several match, the longest
wins the top slot (`claude-code` before `claude`, though both may appear).

### Learning custom emoji

Workspace emoji are read out of Slack's own UI. No API call, no internal
endpoint, no session token. There are two paths.

**Free-riding on an open picker.** While any picker is open — reaction or
composer — every workspace emoji rendered in it is collected, and it keeps
collecting as the user scrolls or switches tabs. Opening the custom tab once
teaches the extension that whole tab. This is what makes the first picker of the
day useful. If something new is learned, the current message is re-ranked once
and the row is repainted in place (once only, or a scrolling user would loop
it).

**A full pass after the picker closes.** Opening a picker marks the workspace as
due if it has never been fully walked, or the last full walk was more than
24 hours ago. The pass then runs *after* that picker closes — never inside the
one the user is looking at, because switching its tab and scrolling it under
their cursor would be obnoxious.

Details that are load-bearing:

- **Never at page load.** A Slack tab is usually restored in the background, and
  a background tab does not paint, so the virtualised grid renders zero cells
  and the harvest silently "succeeds" with nothing. That really happened: the UI
  reported one emoji and no completed sync. A picker being open is proof that
  the tab is in front and the user is there.
- The picker is opened from **the composer's emoji button**, not a message's. It
  opens the identical dialog, but no message is involved, so nothing can post a
  reaction by accident.
- During the pass a class on `<html>` sets the picker to `opacity: 0` and
  `pointer-events: none`. **Not `display: none` or `visibility: hidden`**: those
  remove layout, and a virtualised grid with no geometry renders no cells at
  all, so the harvest would come back empty. The class is removed only after the
  dialog has actually gone, so there is no flash at either end.
- Focus and selection are restored afterwards, and the composer draft is
  compared before and after rather than assumed intact.
- If the user starts typing mid-pass it aborts and hands control back. The
  workspace stays "due" and the next picker close tries again.
- Custom and standard emoji are told apart by **image host**:
  `emoji.slack-edge.com` versus `production-standard-emoji-assets`. The tab is
  not a signal — Slack's "custom" tab also contains the stock extras it ships to
  every workspace (`bowtie`, `shipit`, and friends).

The "is the user busy?" check is deliberately narrow, and two obvious versions of
it were bugs:

- `[role="dialog"]` alone is useless. Slack keeps a huddle container and a
  notification banner permanently mounted with that role, so the check reads
  "busy" forever and the pass never runs.
- `.ReactModal__Overlay` is just as bad: it outlives the dialog it wrapped,
  still holding the closed picker's markup, so it reads "busy" forever after the
  first picker of the session.

What is actually checked: `[role="dialog"][aria-modal="true"]`, `[role="menu"]`,
and the picker itself.

Storage is **per workspace**, keyed by the team id from `/client/<TEAM>/` in the
URL. Work and personal Slacks are often open side by side and one workspace's
vocabulary must never be suggested in another. The pre-0.3 un-keyed `customEmoji`
value is not read, since there is no safe workspace to attribute it to; it is
left in storage rather than deleted.

Harvested emoji enter the candidate list **without descriptions** — the question
asks the model to read the name itself as the meaning, which works well enough
that writing a sentence for each of a few hundred emoji is unnecessary.

When the candidate list does not fit one request it is split and the parts run
in parallel. Scores are per-emoji and never normalised across the set, so
merging is plain concatenation.

### Popup

A 360px panel behind the toolbar icon. There is no options page.

- A **per-workspace switch**. Off means off: no hover prefetch, no suggestion
  row, no learning, no background pass.
- Workspace name, how many emoji are remembered with a preview of the real
  images, when they were last refreshed, and a button to refresh now.
- The API key field is write-only.

## Privacy

- **Message text leaves the browser only for the message you are pointing at,
  plus up to three messages rendered just before it** (in a thread, also the
  parent), which give the model the conversation. It is sent when the pointer rests on a message for 250 ms, and when that
  message's picker opens. Nothing scans a channel, and nothing is sent in the
  background.
- Text goes to the ranking provider's endpoint (`api.typesafe.ai`) and nowhere
  else. Custom emoji are read from the page, never uploaded.
- **The API key never reaches the page or the popup.** It lives in
  `chrome.storage.local`, is read only by the service worker, and there is no
  message that returns it — the popup can set it and ask `hasKey`, nothing more.
- **The per-workspace switch is the real control.** With a workspace off,
  verified at the service worker's own network layer, zero requests are made.
- Permissions are `storage` plus host access to `api.typesafe.ai` and
  `app.slack.com`. No `tabs` permission, which is why the popup cannot read the
  URL of a tab that is not Slack.

## Development

### Popup

The popup is the only part that is built. Everything else is plain JavaScript,
loaded unbuilt.

```sh
cd popup
npm ci
npm run build   # writes extension/popup/ — commit the result
npm run dev     # plain browser preview; chrome.* is mocked in src/lib/bridge.ts
```

`extension/popup/` is committed on purpose so that "Load unpacked" works
straight from a clone. `popup/node_modules` is gitignored.

All `chrome.*` access goes through `src/lib/bridge.ts`, which falls back to a
mock when `chrome.runtime` is absent. That is what makes `npm run dev` useful
for design work.

### Reloading after a change

**Relaunch the browser in the background.** That is the whole recipe, and the
shortcuts do not work:

- `chrome.runtime.reload()` leaves a `--load-extension` extension **disabled**
  in Chrome for Testing 150, and the toggle on `chrome://extensions` will not
  turn it back on.
- The reload button on `chrome://extensions` does the same.

Both fail quietly: the name in `chrome://extensions` updates from the new
manifest, so it looks like a reload worked, while the old content script is
still running — or none is. If a change seems not to have taken, check whether
the extension is switched off before debugging the change itself.

Chrome will also happily keep running a previously installed **service worker
script** across reloads. The tell is a response missing a field only the new
code produces. A background relaunch clears that too.

### Test browser, without stealing focus

The test browser shares a machine with a human, so nothing here may raise a
window. Launch it in the background and attach:

```sh
CHROME="$HOME/.agent-browser/browsers/chrome-<version>/Google Chrome for Testing.app"
open -g -n -a "$CHROME" --args \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.local/state/slack-jev-reactions/profile" \
  --load-extension="$PWD/extension" \
  https://app.slack.com/client/<TEAM>/<CHANNEL>
```

`-g` keeps it behind whatever the human is using. The profile path is historical
and kept only because the Slack login lives in it.

Relaunching this way is also how the extension is reloaded after a code change,
per the section above.

Then, from the CDP session:

- **Never** call `Page.bringToFront`, `Target.activateTarget`, or AppleScript
  `activate`.
- Slack refuses to render the hover toolbar in a page it believes is hidden.
  `Emulation.setFocusEmulationEnabled({enabled: true})` on the page session makes
  the page report `visibilityState === "visible"` and `hasFocus() === true` while
  the window stays in the background. The toolbar then renders normally.
- Screenshots work without foregrounding via `Page.captureScreenshot`.

### Things that break Slack's hover toolbar

- A hidden or background page: see focus emulation above.
- Setting a viewport override (`Emulation.setDeviceMetricsOverride`, which
  `agent-browser set viewport` uses). Slack appears to treat the page as a touch
  device and stops rendering hover affordances entirely. Do not use it against
  Slack.
- Moving the mouse away between locating the button and clicking it: the toolbar
  is removed from the DOM and the click lands on whatever is underneath, which
  is often the composer.

## What is known about the ranking

Measured against the live model, worth keeping because it explains the constants
in the code.

- A response takes roughly 0.5 s, so asking when the hover toolbar appears
  leaves it ready by the time the picker opens.
- Per-emoji independent scoring beats a single choice question. With one
  distribution the probabilities sum to 1, so a single winner drowns out
  everything else, and the point here is to offer several.
- Descriptions work best written as "what this emoji means in Slack", in
  English. The model reads the question literally.
- **Leniency varies by message type.** Work updates put several candidates in the
  0.8s; one-line idea memos top out around 0.65. Hence `MIN_SCORE = 0.5` in
  `content.js`.
- **Name-only custom emoji still find the subject.** "Repomix の新バージョンを
  リリースしました" → `:shipit:` 0.87, `:thumbsup_all:` 0.80, `:repomix:` 0.73.
  "Claude Code でリファクタしたら一発で通った" → `:thumbsup_all:` 0.84,
  `:shipit:` 0.81, `:claude-code:` 0.80.
- **The described-versus-name-only gap is small.** Across those two messages the
  maxima were 0.96 / 0.87 for standard against 0.87 / 0.84 for custom, and the
  means 0.428 / 0.341 and 0.426 / 0.422. The lower custom mean is mostly
  irrelevant emoji scoring low, which is correct. No rescaling is applied.
- Cost is about **79 input tokens per candidate** (73 candidates → 5,786 input
  tokens, 228 ms). Roughly 800 candidates would fit one request inside a 64k
  budget; the implementation splits at 20,000 tokens or 200 questions.
- A full custom-emoji harvest took 3.4 s for 17 emoji. The virtualised grid was
  exercised on a standard tab: 503 emoji in 6 scroll passes over 1.8 s, with
  only 189 cells in the DOM at any moment.

## Known limits and roadmap

- **Browser Slack only.** The desktop app is Electron and cannot load Chrome
  extensions.
- **Slack's DOM is not a public API.** When it changes, selectors need fixing.
  They are all in one object to make that a small job.
- **Chunked requests are untested in practice.** No workspace tried so far has
  enough emoji to force a second request. The merge is trivially correct
  because scores are independent, but it has never actually run.
- The score floor and the number of suggestions are hard-coded. They could
  reasonably move into the popup.
- The standard candidate list and per-emoji description overrides no longer have
  an editing surface; defaults live in code. Stored values are still read, so an
  editor could come back.
- The popup's refresh button brings the Slack tab to the front before running,
  because a background tab renders nothing. Leaving it to the automatic pass
  after the next picker close avoids that.
- **A Discord adapter** would be a second file under `src/sites/` implementing
  the same small interface. Nothing above that layer should need to change.
- **Other providers** likewise: one module exporting `rank()` and a label.
- A Chrome Web Store listing may have to use the "… for Slack" form of the name.
  Store titles that lead with another company's trademark have been taken down
  before; the in-product name can stay as it is.
- The suggestion row follows Slack's light and dark themes by using
  `currentColor` and translucent greys rather than fixed colours. The popup
  follows the OS `prefers-color-scheme`, since Chrome does not tell a popup the
  browser theme.
