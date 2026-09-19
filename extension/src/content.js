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

  function request(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "suggest", key: message.id, text: message.text }, (res) => {
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

  function paint(row, suggestions) {
    const top = suggestions.filter((s) => s.p >= MIN_SCORE).slice(0, MAX_SUGGESTIONS);
    if (top.length === 0) {
      paintMessage(row, "ぴったりの候補はありませんでした。");
      return;
    }
    const body = shell(row);
    for (const s of top) {
      body.appendChild(button(s));
    }
  }

  function button(s) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sjr-item";
    b.title = `${s.shortcode}  ${s.p.toFixed(2)}`;
    b.setAttribute("aria-label", `${s.shortcode} ${Math.round(s.p * 100)}%`);

    const glyph = document.createElement("span");
    glyph.className = s.glyph ? "sjr-glyph" : "sjr-glyph sjr-glyph--text";
    glyph.textContent = s.glyph || s.shortcode;
    b.appendChild(glyph);

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
