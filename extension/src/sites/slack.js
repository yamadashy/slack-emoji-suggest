/**
 * Site adapter: Slack's web client.
 *
 * Everything that knows Slack's DOM lives here. `content.js` drives it and
 * knows nothing about this site, so a second adapter (a different chat app)
 * would be a sibling file with the same shape and no changes above it.
 *
 * The adapter object, published as `self.SiteAdapter`:
 *
 *   name                      identifier, for logs
 *   workspaceId()             the current workspace's id, or null. Emoji are
 *                             stored per workspace: one workspace's custom
 *                             emoji must never be suggested in another.
 *   observe({onHover, onPickerOpen})
 *                             start listening. `onHover(message|null)` fires
 *                             on every pointer move onto/off a message (the
 *                             caller debounces). `onPickerOpen({message, picker})`
 *                             fires once the reaction picker is on screen and
 *                             we know which message it belongs to.
 *   mountRow(picker)          insert an empty container at the top of the
 *                             picker and return it; idempotent per picker.
 *   react(shortcode)          add that reaction to the message the open picker
 *                             belongs to. Resolves true on success.
 *   watchPicker(picker, onEmoji)
 *                             report workspace emoji as they render while the
 *                             picker is open -- scrolling, switching tabs.
 *                             Returns a stop function; self-stops on close.
 *   collectCustomEmoji(opts)  walk the whole custom-emoji tab. `opts.hidden`
 *                             makes the picker invisible for the duration;
 *                             `opts.shouldAbort()` lets the caller cut it short.
 *   isBusy()                  true when the user has something open or is
 *                             mid-action, so a background harvest must not run.
 *   hasComposer()             whether the harvest's entry point exists yet.
 *   composerDraft()           the current draft text, for before/after checks.
 *
 * A `message` is `{id, text}`: `id` is stable and unique (channel + ts), `text`
 * is the plain body. An emoji is `{name, url}`. Nothing else crosses the
 * boundary.
 *
 * Slack's DOM is not a public API. Selectors are all in SEL below, and every
 * one of them is a `data-qa` attribute or an ARIA role rather than a hashed
 * class name, because those are the parts Slack keeps stable for its own
 * end-to-end tests.
 */
(() => {
  const SEL = {
    /** One rendered message row. Carries data-msg-ts / data-msg-channel-id. */
    message: '[data-qa="message_container"]',
    /** The message body. innerText of this is what gets ranked. */
    messageText: '[data-qa="message-text"]',
    /** "リアクションを追加..." in the hover toolbar. Also matches the picker
     *  trigger that sits at the end of an existing reaction bar. */
    addReaction: '[data-qa="add_reaction"], [data-qa="add_reaction_button"]',
    /** The emoji picker dialog. Note the hyphen -- the toolbar button uses an
     *  underscore, the dialog does not. */
    picker: '[data-qa="emoji-picker"]',
    /** Inside the picker: the scrolling area with the emoji grid. Our row is
     *  inserted immediately before it, i.e. under the search box and above
     *  「よく使う絵文字」, without touching the virtualised grid itself. */
    pickerList: ".p-emoji_picker__list_container",
    /** The picker's own search box. Typing here is how we make an arbitrary
     *  emoji render, including ones far outside the current scroll position. */
    pickerInput: '[data-qa="emoji_picker_input"]',
    /** One emoji cell in the grid; data-name is the shortcode without colons. */
    pickerItem: '[data-qa="emoji_list_item"]',
    /** The emoji button in the message composer. It opens the very same picker
     *  as a message's "add reaction" button, which is why harvesting uses it:
     *  no message is involved, so a stray click cannot post a reaction. */
    composerEmojiButton: '[data-qa="emoji_toolbar_button"]',
    /** The composer's text box, for the "is the user mid-sentence" check. */
    composerInput: '[data-qa="message_input"]',
    /** The workspace name in the sidebar header, for the popup to show. */
    workspaceName: '[data-qa="ia4_sidebar_header__title"]',
    /** The category tabs, and the workspace-emoji one (the Slack-logo tab). */
    pickerTab: '[data-qa^="emoji_group_tab_"]',
    pickerTabSelected: '[data-qa^="emoji_group_tab_"][aria-selected="true"]',
    pickerTabCustom: '[data-qa="emoji_group_tab_slack-logo"]',
    /** react-virtualized's scroll viewport for the grid. The one hashed-looking
     *  name here is a library class, not a Slack one, so it changes only when
     *  Slack changes libraries. */
    pickerScroller: ".ReactVirtualized__List",
    /**
     * Anything genuinely modal on screen: if one of these is up the user is
     * busy and a background pass has to wait.
     *
     * Two things are deliberately *not* in this list, both of which broke it:
     *
     * - bare `[role="dialog"]`: Slack keeps a huddle container and a
     *   notification banner permanently mounted with that role, so the check
     *   read "busy" forever and the pass never ran;
     * - `.ReactModal__Overlay`: it outlives the dialog it wrapped, still
     *   carrying the closed picker's markup, so it reads "busy" forever after
     *   the first picker of the session.
     *
     * What is left is what actually means "something is in front of the user".
     * The open-picker check below covers the emoji picker itself.
     */
    anyOverlay: '[role="dialog"][aria-modal="true"], [role="menu"]',
  };

  /** Workspace emoji are served from this host; the standard set is not. That
   *  is the only reliable way to tell them apart, because Slack's "custom" tab
   *  also contains the stock extras it ships to every workspace. */
  const CUSTOM_EMOJI_HOST = "emoji.slack-edge.com";

  /** Set on <html> while a background harvest runs; content.css uses it to make
   *  the picker fully transparent. Deliberately opacity and not display or
   *  visibility: the grid is virtualised off scroll geometry, and an element
   *  that is not laid out has no geometry, so `display:none` would render zero
   *  cells and harvest nothing. Verified that cells render and scroll at
   *  opacity 0. */
  const HARVESTING_CLASS = "sjr-harvesting";

  /** How long to wait for the picker to mount after its button is clicked. */
  const PICKER_WAIT_MS = 3000;
  /** How long to wait for a searched-for emoji to appear in the grid. */
  const EMOJI_WAIT_MS = 2000;
  /** One settle after each scroll step, for react-virtualized to render. */
  const SCROLL_SETTLE_MS = 110;
  /** Guard against an infinite loop if scrollTop ever stops behaving. */
  const MAX_SCROLL_PASSES = 400;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** True while this file is clicking Slack's own buttons, so the click
   *  listener below does not mistake the harvest for the user. */
  let selfDriving = false;

  /** https://app.slack.com/client/<TEAM>/<CHANNEL> */
  function workspaceId() {
    const m = location.pathname.match(/\/client\/([A-Z0-9]+)/i);
    return m ? m[1] : null;
  }

  function getMessage(el) {
    const root = el?.closest?.(SEL.message);
    if (!root) return null;
    const ts = root.getAttribute("data-msg-ts");
    const channel = root.getAttribute("data-msg-channel-id");
    if (!ts) return null;
    const body = root.querySelector(SEL.messageText);
    const text = (body?.innerText || "").trim();
    if (!text) return null;
    return { id: `${channel || "?"}/${ts}`, text };
  }

  /**
   * Resolve once the picker dialog is on screen.
   *
   * A MutationObserver rather than a poll, and it only exists between the click
   * and the picker showing up -- a few hundred ms -- so Slack is never running
   * with a permanent subtree observer attached. body/subtree is the narrowest
   * root available: the picker is portalled into a `.ReactModalPortal` div that
   * React creates on demand, so there is no stable parent to watch instead.
   */
  function waitForPicker() {
    return new Promise((resolve) => {
      const found = document.querySelector(SEL.picker);
      if (found) return resolve(found);
      let timer = 0;
      const obs = new MutationObserver(() => {
        const picker = document.querySelector(SEL.picker);
        if (!picker) return;
        clearTimeout(timer);
        obs.disconnect();
        resolve(picker);
      });
      obs.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, PICKER_WAIT_MS);
    });
  }

  /** Resolve once the picker is gone, so the hiding class can come off with no
   *  flash of a dialog that is on its way out. */
  async function waitForPickerGone(timeoutMs = 2000) {
    const started = Date.now();
    while (document.querySelector(SEL.picker) && Date.now() - started < timeoutMs) {
      await sleep(50);
    }
    return !document.querySelector(SEL.picker);
  }

  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  /** React listens for `input`, and React's own value tracker has to be
   *  bypassed with the native setter or the event is swallowed as a no-op. */
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Every workspace emoji currently in the DOM under `root`, keyed by name.
   *  Scans the whole picker, so 「よく使う絵文字」, search results and the custom
   *  tab all count. Returns how many were new. */
  function harvestInto(found, root) {
    let added = 0;
    for (const el of root.querySelectorAll(SEL.pickerItem)) {
      const name = el.getAttribute("data-name");
      const img = el.querySelector("img");
      if (!name || !img || found.has(name)) continue;
      if (!img.src.includes(CUSTOM_EMOJI_HOST)) continue;
      found.set(name, img.src);
      added++;
    }
    return added;
  }

  /**
   * Scroll the virtualised grid from top to bottom, collecting as it renders.
   *
   * The grid only keeps the visible window in the DOM (measured: 189 cells at a
   * time out of 503 on the smileys tab), so there is no list to read -- it has
   * to be walked. Steps are three quarters of a viewport so consecutive windows
   * overlap and nothing can fall between two passes.
   */
  async function scrollHarvest(picker, found, shouldAbort) {
    const scroller = picker.querySelector(SEL.pickerScroller);
    if (!scroller) return 0;
    let passes = 0;
    scroller.scrollTop = 0;
    await sleep(SCROLL_SETTLE_MS);
    harvestInto(found, picker);
    while (passes < MAX_SCROLL_PASSES) {
      if (shouldAbort?.()) break;
      passes++;
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(before + Math.floor(scroller.clientHeight * 0.75), scroller.scrollHeight);
      await sleep(SCROLL_SETTLE_MS);
      harvestInto(found, picker);
      if (scroller.scrollTop <= before) break; // nothing more to scroll
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        await sleep(SCROLL_SETTLE_MS * 2); // let the last window settle
        harvestInto(found, picker);
        break;
      }
    }
    return passes;
  }

  self.SiteAdapter = {
    name: "slack",
    workspaceId,

    /** Heading of the suggestion row. Names the product, so it lives here:
     *  the site-neutral code must not know which site it is running on. */
    rowLabel: "Slack Emoji Suggest によるおすすめ",

    /** A human-readable workspace name, or null to fall back to the id. */
    workspaceName() {
      const el = document.querySelector(SEL.workspaceName);
      const text = (el?.textContent || "").trim();
      return text || null;
    },

    hasComposer() {
      return !!document.querySelector(SEL.composerEmojiButton);
    },

    composerDraft() {
      const el = document.querySelector(SEL.composerInput);
      return el ? el.textContent : null;
    },

    /** Why it is a bad moment to touch the UI, or null when it is fine. */
    busyReason() {
      if (document.querySelector(SEL.picker)) return "ピッカーが開いています";
      const overlay = [...document.querySelectorAll(SEL.anyOverlay)].find((e) => e.offsetParent !== null);
      if (overlay) return "別のダイアログが開いています";
      const composer = document.querySelector(SEL.composerInput);
      if (composer && composer.contains(document.activeElement) && (composer.textContent || "").trim() !== "") {
        return "入力中です"; // mid-sentence: never steal focus
      }
      return null;
    },

    isBusy() {
      return this.busyReason() !== null;
    },

    observe({ onHover, onPickerOpen }) {
      // One delegated listener instead of per-message handlers: Slack recycles
      // message rows as you scroll, so anything attached per row leaks.
      document.addEventListener(
        "mouseover",
        (e) => {
          onHover(getMessage(e.target));
        },
        { passive: true, capture: true },
      );

      // Capture phase so we learn which message the picker will belong to
      // before Slack's own handler opens it. Slack gives the picker no link
      // back to its message, so this click is the only place to find out.
      //
      // The composer's emoji button counts too: it opens the same picker, and
      // an open picker is the signal that the tab is foreground and the user
      // is present. Those come through with `message: null` -- there is
      // nothing to suggest for, only something to learn from.
      document.addEventListener(
        "click",
        (e) => {
          if (selfDriving) return; // our own harvest clicking that same button
          const reactionButton = e.target?.closest?.(SEL.addReaction);
          const composerButton = e.target?.closest?.(SEL.composerEmojiButton);
          if (!reactionButton && !composerButton) return;
          const message = reactionButton ? getMessage(reactionButton) : null;
          if (reactionButton && !message) return;
          waitForPicker().then((picker) => {
            if (picker) onPickerOpen({ message, picker });
          });
        },
        { capture: true },
      );
    },

    /**
     * Learn workspace emoji for free while the user has the picker open.
     *
     * Everything they scroll past or switch to gets collected, so opening the
     * custom tab once teaches us that whole tab. Scoped to the picker element
     * and torn down when it closes, so nothing outlives the dialog.
     */
    watchPicker(picker, onEmoji, onClose) {
      const found = new Map();
      let timer = 0;
      let stopped = false;

      const report = () => {
        const before = found.size;
        harvestInto(found, picker);
        if (found.size > before) onEmoji([...found].map(([name, url]) => ({ name, url })));
      };
      const schedule = () => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(report, 150);
      };

      report(); // whatever is on screen the moment it opens

      // Scroll is capture-phase because the scrolling element is a descendant
      // and scroll events do not bubble.
      picker.addEventListener("scroll", schedule, { capture: true, passive: true });
      picker.addEventListener("click", schedule, { capture: true, passive: true });
      const obs = new MutationObserver(schedule);
      obs.observe(picker, { childList: true, subtree: true });

      // Self-destruct when the dialog goes away, so a forgotten stop() cannot
      // leak an observer for the rest of the session. The close is also worth
      // reporting: it is the moment the screen is the user's again.
      const gone = new MutationObserver(() => {
        if (picker.isConnected) return;
        stop();
        onClose?.();
      });
      gone.observe(document.body, { childList: true, subtree: true });

      function stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        obs.disconnect();
        gone.disconnect();
        picker.removeEventListener("scroll", schedule, { capture: true });
        picker.removeEventListener("click", schedule, { capture: true });
      }
      return stop;
    },

    mountRow(picker) {
      const list = picker.querySelector(SEL.pickerList);
      if (!list) return null;
      // Re-opening the picker re-uses the row rather than stacking a second one.
      const existing = list.parentElement.querySelector("[data-sjr-row]");
      if (existing) return existing;
      const row = document.createElement("div");
      row.setAttribute("data-sjr-row", "");
      row.className = "sjr-row";
      list.parentElement.insertBefore(row, list);
      return row;
    },

    async react(shortcode) {
      const picker = document.querySelector(SEL.picker);
      if (!picker) return false;
      const name = shortcode.replace(/^:|:$/g, "");
      const input = picker.querySelector(SEL.pickerInput);
      if (!input) return false;

      // Driving the picker's own search is what makes this reliable: the grid
      // is virtualised, so an emoji that is not scrolled into view has no DOM
      // node to click. After a search there is exactly one match, guaranteed
      // rendered, and clicking it is the same code path as a human click --
      // no Slack API token anywhere.
      setInputValue(input, name);
      const item = await waitFor(
        () => picker.querySelector(`${SEL.pickerItem}[data-name="${CSS.escape(name)}"]`),
        EMOJI_WAIT_MS,
      );
      if (!item) return false;
      item.click(); // Slack adds the reaction and closes the picker itself
      return true;
    },

    /**
     * Walk the whole custom-emoji tab.
     *
     * Opens the picker from the *composer's* emoji button rather than a
     * message's, so nothing here can post a reaction by accident.
     *
     * With `opts.hidden` the picker is transparent for the whole of it, and the
     * class only comes off once the dialog has actually gone, so there is no
     * flash at either end. Focus and selection are captured before and put back
     * after, and the composer's draft is compared before/after rather than
     * assumed intact.
     */
    async collectCustomEmoji(opts = {}) {
      const { hidden = false, shouldAbort } = opts;
      const started = Date.now();
      const openedByUs = !document.querySelector(SEL.picker);
      let picker = document.querySelector(SEL.picker);

      const previousActive = document.activeElement;
      const draftBefore = this.composerDraft();
      selfDriving = true;
      if (hidden) document.documentElement.classList.add(HARVESTING_CLASS);

      try {
        if (openedByUs) {
          const trigger = document.querySelector(SEL.composerEmojiButton);
          if (!trigger) return { ok: false, error: "絵文字ピッカーを開くボタンが見つかりませんでした。" };
          trigger.click();
          picker = await waitForPicker();
          if (!picker) return { ok: false, error: "絵文字ピッカーが開きませんでした。" };
        }

        const previousTab = picker.querySelector(SEL.pickerTabSelected)?.getAttribute("data-qa") || null;
        const scroller = picker.querySelector(SEL.pickerScroller);
        const previousScroll = scroller ? scroller.scrollTop : 0;

        try {
          const customTab = picker.querySelector(SEL.pickerTabCustom);
          if (!customTab) return { ok: false, error: "カスタム絵文字のタブが見つかりませんでした。" };
          customTab.click();
          await sleep(700); // the tab swap re-mounts the grid

          const found = new Map();
          const passes = await scrollHarvest(picker, found, shouldAbort);
          return {
            ok: true,
            aborted: !!shouldAbort?.(),
            emoji: [...found].map(([name, url]) => ({ name, url })),
            ms: Date.now() - started,
            passes,
          };
        } finally {
          // Leave the picker as it was found.
          if (openedByUs) {
            document.querySelector(SEL.composerEmojiButton)?.click();
            await waitForPickerGone();
          } else if (picker.isConnected) {
            if (previousTab) picker.querySelector(`[data-qa="${previousTab}"]`)?.click();
            const s = picker.querySelector(SEL.pickerScroller);
            if (s) s.scrollTop = previousScroll;
          }
        }
      } finally {
        // Only now is un-hiding safe: the dialog is gone, so no frame can paint
        // a half-torn-down picker.
        if (hidden) document.documentElement.classList.remove(HARVESTING_CLASS);
        selfDriving = false;
        if (previousActive?.isConnected && typeof previousActive.focus === "function") {
          try {
            previousActive.focus({ preventScroll: true });
          } catch {
            /* focus is best-effort */
          }
        }
        const draftAfter = this.composerDraft();
        if (draftBefore !== draftAfter) {
          console.warn("[emoji-suggest] composer draft changed during harvest", { draftBefore, draftAfter });
        }
      }
    },
  };
})();
