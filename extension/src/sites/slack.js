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
 *
 * A `message` is `{id, text}`: `id` is stable and unique (channel + ts), `text`
 * is the plain body. Nothing else crosses the boundary.
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
  };

  /** How long to wait for the picker to mount after its button is clicked. */
  const PICKER_WAIT_MS = 3000;
  /** How long to wait for a searched-for emoji to appear in the grid. */
  const EMOJI_WAIT_MS = 2000;

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

  self.SiteAdapter = {
    name: "slack",

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
      document.addEventListener(
        "click",
        (e) => {
          const button = e.target?.closest?.(SEL.addReaction);
          if (!button) return;
          const message = getMessage(button);
          if (!message) return;
          waitForPicker().then((picker) => {
            if (picker) onPickerOpen({ message, picker });
          });
        },
        { capture: true },
      );
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
  };
})();
