/**
 * The site-neutral half: debounce, cache, and the suggestion row's contents.
 *
 * It talks to two things and knows nothing else: `self.SiteAdapter` (which
 * knows the chat app's DOM) and the service worker (which knows the API key
 * and the ranking model). No selectors and no model names below this line.
 *
 * Privacy: a message's text leaves the page only because the pointer settled
 * on that one message, or its picker was opened. Nothing scans the channel.
 */
(() => {
  const adapter = self.SiteAdapter;
  if (!adapter) return;

  /** Pointer has to rest this long before a message is worth a request, so
   *  sweeping the mouse down the channel fires nothing. */
  const HOVER_DEBOUNCE_MS = 250;
  /**
   * Scores run lenient, so a floor is needed or everything looks suggested.
   *
   * 0.8 was the figure measured on ordinary work updates: "deployed, no
   * errors" scores :ship: 0.96, :white_check_mark: 0.93, :tada: 0.93. Short
   * idea memos score far lower across the board -- a one-line memo topped out
   * at 0.65 -- so an 0.8 floor shows nothing at all on a memo channel. The
   * floor exists to drop junk, and with only five slots and a visible
   * probability bar, 0.5 does that without silencing whole channels.
   */
  const MIN_SCORE = 0.5;
  const MAX_SUGGESTIONS = 5;
  /** Mirrors the worker's cache so a re-opened picker paints with no flicker. */
  const LOCAL_CACHE_MAX = 50;

  /** id -> {shortcode, glyph, p}[] */
  const cache = new Map();

  let hoverTimer = 0;
  let hoveredId = null;
  /** Bumped on every render; a late answer for an older render is dropped. */
  let renderSeq = 0;
  /** Set while a background pass runs, so the user can cut it short. */
  let harvestAbort = false;
  let harvesting = false;

  const workspace = adapter.workspaceId?.() || null;

  /**
   * The privacy switch, read straight from storage.
   *
   * When a workspace is off, nothing happens for it at all: no hover prefetch,
   * no suggestion row, no learning, no background pass. The owner keeps work
   * Slacks open alongside personal ones, so "off" has to mean off, not "off
   * except for the part that already sent the message somewhere".
   *
   * Read synchronously-ish at startup and kept current by the storage event,
   * so flipping the switch takes effect without reloading the tab.
   */
  let enabled = true;
  chrome.storage.local.get("workspaceEnabled", (s) => {
    if (workspace) enabled = s?.workspaceEnabled?.[workspace] !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.workspaceEnabled || !workspace) return;
    enabled = changes.workspaceEnabled.newValue?.[workspace] !== false;
  });

  // If the user starts typing mid-pass, hand the UI straight back. Pointer
  // events are deliberately not included: the pass runs right after a click
  // (the one that dismissed their picker), so treating every click as an
  // interruption would abort it every single time.
  document.addEventListener(
    "keydown",
    () => {
      if (harvesting) harvestAbort = true;
    },
    { capture: true, passive: true },
  );

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("[emoji-suggest] runtime error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(res);
      });
    });
  }

  function request(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "suggest", key: message.id, text: message.text, workspace }, (res) => {
        if (chrome.runtime.lastError) {
          // The user-facing sentence stays short; the real reason goes to the
          // console, because every cause here ("context invalidated" after a
          // reload, a worker that failed to start) looks identical on screen.
          console.warn("[suggest] runtime error:", chrome.runtime.lastError.message);
          resolve({ ok: false, error: "拡張機能が応答しませんでした。再読み込みしてください。" });
          return;
        }
        if (res?.ok) {
          cache.set(message.id, res.suggestions);
          while (cache.size > LOCAL_CACHE_MAX) cache.delete(cache.keys().next().value);
        }
        resolve(res || { ok: false, error: "不明なエラーです。" });
      });
    });
  }

  adapter.observe({
    onHover(message) {
      if (!enabled) return;
      if (!message) {
        clearTimeout(hoverTimer);
        hoveredId = null;
        return;
      }
      if (message.id === hoveredId) return;
      hoveredId = message.id;
      clearTimeout(hoverTimer);
      if (cache.has(message.id)) return;
      hoverTimer = setTimeout(() => {
        // Prefetch only. The answer lands in the cache; if the picker opened
        // first it is already waiting on the same in-flight request.
        if (hoveredId === message.id) void request(message);
      }, HOVER_DEBOUNCE_MS);
    },

    async onPickerOpen({ message, picker }) {
      if (!enabled) return;
      // Learn for free from whatever the picker shows, and keep learning while
      // it stays open -- scrolling, switching to the workspace tab. This is
      // what makes the very first picker of a session useful, before the
      // background harvest has necessarily finished.
      // A picker being open means the tab is foreground and the user is here:
      // the right moment to decide the workspace needs a full pass, and the
      // wrong moment to actually do one.
      harvestAbort = true; // stop any pass still running; theirs takes priority
      void noteHarvestOpportunity();

      let reRanked = false;
      adapter.watchPicker?.(
        picker,
        async (emoji) => {
          const res = await send({ type: "mergeCustomEmoji", workspace, emoji });
          // Only worth re-ranking if something genuinely new turned up, and
          // only once per picker open, or a scrolling user would loop it.
          if (!res?.ok || !res.added || reRanked || !message || !picker.isConnected) return;
          reRanked = true;
          cache.delete(message.id);
          await send({ type: "invalidate", key: message.id });
          const again = await request(message);
          const row = adapter.mountRow(picker);
          if (!row || !row.isConnected) return;
          if (again?.ok) paint(row, again.suggestions);
        },
        () => void harvestAfterPickerClose(),
      );

      // The composer's picker has no message behind it: there is nothing to
      // suggest for, only something to learn from.
      if (!message) return;

      const row = adapter.mountRow(picker);
      if (!row) return;
      const seq = ++renderSeq;

      const cached = cache.get(message.id);
      if (cached) {
        paint(row, cached);
        return;
      }
      paintLoading(row);
      const res = await request(message);
      if (seq !== renderSeq || !row.isConnected) return;
      if (res.ok) paint(row, res.suggestions);
      else paintMessage(row, res.error);
    },
  });

  // The popup cannot reach a page, so its requests arrive here via the worker.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "siteInfo") {
      sendResponse({ ok: true, workspace, workspaceName: adapter.workspaceName?.() || null });
      return true;
    }
    if (msg?.type !== "collectCustomEmoji") return false;
    if (!adapter.collectCustomEmoji) {
      sendResponse({ ok: false, error: "このサイトではカスタム絵文字を取り込めません。" });
      return true;
    }
    runHarvest({ hidden: msg.hidden !== false }).then(
      (res) => sendResponse({ ...res, workspace }),
      (err) => sendResponse({ ok: false, error: err?.message || "取り込みに失敗しました。" }),
    );
    return true;
  });

  /* ------------------------------------------------- automatic harvesting */

  function runHarvest({ hidden }) {
    harvestAbort = false;
    harvesting = true;
    return adapter
      .collectCustomEmoji({ hidden, shouldAbort: () => harvestAbort })
      .finally(() => {
        harvesting = false;
      });
  }

  /**
   * The harvest is triggered by the user's own picker use, not by page load.
   *
   * Loading is the wrong moment: a Slack tab is usually restored in the
   * background, where nothing paints and the virtualised grid renders zero
   * cells, so a load-time harvest quietly collects nothing. Opening a picker,
   * on the other hand, proves the tab is foreground and the user is right
   * there.
   *
   * It does not run *inside* the picker they are looking at -- switching that
   * to the workspace tab and scrolling it under their cursor would be rude.
   * It waits for them to finish, then does its own pass invisibly.
   */
  let harvestDue = false;

  async function noteHarvestOpportunity() {
    if (!workspace || !adapter.collectCustomEmoji || harvestDue) return;
    const state = await send({ type: "workspaceState", workspace });
    if (state && !state.fresh) harvestDue = true;
  }

  async function harvestAfterPickerClose() {
    if (!harvestDue || harvesting) return;
    // Let Slack finish tearing the dialog down before opening another.
    await new Promise((r) => setTimeout(r, 400));

    const blocked = adapter.busyReason?.();
    if (blocked) {
      void send({ type: "recordHarvest", workspace, error: blocked });
      return; // stays due; the next picker close gets another go
    }

    harvestAbort = false;
    const res = await runHarvest({ hidden: true }).catch((err) => ({ ok: false, error: err?.message }));
    if (res?.ok && !res.aborted && res.emoji?.length) {
      await send({ type: "mergeCustomEmoji", workspace, emoji: res.emoji, full: true });
      harvestDue = false;
      return;
    }
    void send({
      type: "recordHarvest",
      workspace,
      error: res?.aborted ? "操作が入ったので中断しました" : res?.error || "絵文字を読み取れませんでした",
    });
  }

  function shell(row) {
    row.textContent = "";
    const label = document.createElement("div");
    label.className = "sjr-label";
    label.textContent = "おすすめ";
    row.appendChild(label);
    const body = document.createElement("div");
    body.className = "sjr-body";
    row.appendChild(body);
    return body;
  }

  function paintLoading(row) {
    const body = shell(row);
    body.className = "sjr-body sjr-body--status";
    for (let i = 0; i < MAX_SUGGESTIONS; i++) {
      const ph = document.createElement("span");
      ph.className = "sjr-placeholder";
      body.appendChild(ph);
    }
  }

  function paintMessage(row, text) {
    const body = shell(row);
    body.className = "sjr-body sjr-body--status";
    const p = document.createElement("span");
    p.className = "sjr-status";
    p.textContent = text;
    body.appendChild(p);
  }

  /**
   * Pick the five to show.
   *
   * An emoji whose name the message actually said comes first and ignores the
   * score floor -- if someone writes 「Claude Codeの絵文字つけてほしい」 then
   * `:claude-code:` is the answer whatever the ranker thought. Longest name
   * first among those, so `:claude-code:` outranks `:claude:` while both can
   * still appear. The rest fill the row by score as before.
   */
  function choose(suggestions) {
    const matched = suggestions
      .filter((s) => s.matched)
      .sort((a, b) => (b.matchLength || 0) - (a.matchLength || 0) || b.p - a.p);
    const rest = suggestions.filter((s) => !s.matched && s.p >= MIN_SCORE);
    return [...matched, ...rest].slice(0, MAX_SUGGESTIONS);
  }

  function paint(row, suggestions) {
    const top = choose(suggestions);
    if (top.length === 0) {
      paintMessage(row, "ぴったりの候補はありませんでした。");
      return;
    }
    const body = shell(row);
    for (const s of top) {
      body.appendChild(button(s));
    }
  }

  /**
   * What the button shows: the workspace emoji's own image, a standard glyph,
   * or -- last resort -- the shortcode text, shrunk to fit the same cell.
   */
  function face(s) {
    if (s.url) {
      const img = document.createElement("img");
      img.className = "sjr-glyph sjr-glyph--img";
      img.src = s.url;
      img.alt = s.shortcode;
      img.loading = "lazy";
      return img;
    }
    const glyph = document.createElement("span");
    glyph.className = s.glyph ? "sjr-glyph" : "sjr-glyph sjr-glyph--text";
    glyph.textContent = s.glyph || s.shortcode;
    return glyph;
  }

  function button(s) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = s.matched ? "sjr-item sjr-item--matched" : "sjr-item";
    b.title = s.matched
      ? `${s.shortcode}  ${s.p.toFixed(2)}  （本文に名前が出ています）`
      : `${s.shortcode}  ${s.p.toFixed(2)}`;
    b.setAttribute("aria-label", `${s.shortcode} ${Math.round(s.p * 100)}%${s.matched ? " 名前一致" : ""}`);

    b.appendChild(face(s));

    // A thin bar rather than a number: it reads at a glance and does not make
    // the row look like a table. The exact figure is in the tooltip.
    const bar = document.createElement("span");
    bar.className = "sjr-bar";
    const fill = document.createElement("span");
    fill.className = "sjr-bar__fill";
    fill.style.width = `${Math.round(s.p * 100)}%`;
    bar.appendChild(fill);
    b.appendChild(bar);

    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void adapter.react(s.shortcode);
    });
    return b;
  }
})();
