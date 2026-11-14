/* Page scan controls and sentence popover. All page-facing UI lives in one Shadow DOM. */
(() => {
  if (globalThis.WikiFactPageUI) return;
  const STYLE = `
    :host { all: initial; color-scheme: light; --paper:oklch(96% .009 82); --plate:oklch(99.5% .003 82); --paper-2:oklch(92% .012 82); --paper-3:oklch(87.5% .014 80); --ink:oklch(16% .006 60); --muted:oklch(46% .01 60); --rule:oklch(81% .012 80); --green:oklch(50% .12 150); --red:oklch(52% .19 27); --focus:oklch(50% .16 38); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); }
    *,*::before,*::after { box-sizing:border-box; } [hidden] { display:none !important; }
    button,select { font:inherit; color:inherit; } button,select,a { pointer-events:auto; }
    button { min-height:32px; border:1px solid var(--ink); border-radius:0; background:var(--ink); color:var(--paper); padding:5px 9px; cursor:pointer; font-weight:500; }
    button:hover { background:oklch(27% .006 60); } button.quiet { background:transparent; color:var(--ink); } button.quiet:hover { background:var(--paper-2); } button:disabled { opacity:.5; cursor:default; }
    :focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
    a { color:inherit; text-underline-offset:2px; overflow-wrap:anywhere; } a:hover { color:var(--focus); }
    h2,h3,p,blockquote,ol,ul { margin:0; } h2 { font-size:16px; letter-spacing:-.025em; line-height:1.2; } h3 { font-size:14px; line-height:1.3; }
    p,blockquote,li { overflow-wrap:anywhere; } .muted { color:var(--muted); font-size:12px; } .error { color:var(--red); }
    .guide,.popover { position:fixed; pointer-events:auto; background:var(--plate); border:2px solid var(--ink); box-shadow:6px 6px 0 var(--paper-3); padding:12px; z-index:1; }
    .guide { width:310px; max-width:calc(100vw - 24px); right:12px; bottom:12px; display:grid; gap:8px; max-height:calc(100dvh - 24px); overflow:auto; }
    .guide-head,.row { display:flex; align-items:center; justify-content:space-between; gap:8px; } .guide-head h2 { min-width:0; } .guide-actions { display:flex; flex-shrink:0; gap:6px; } .guide-head button { font-size:12px; min-height:26px; padding:2px 7px; }
    .legend { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:12px; color:var(--muted); } .legend span { display:inline-flex; gap:5px; align-items:center; } .dot { width:9px; height:9px; display:inline-block; background:var(--muted); } .green { background:var(--green); } .red { background:var(--red); }
    progress { width:100%; height:6px; appearance:none; border:0; background:var(--paper-3); accent-color:var(--ink); } progress::-webkit-progress-bar { background:var(--paper-3); } progress::-webkit-progress-value { background:var(--ink); }
    .controls { display:flex; flex-wrap:wrap; gap:6px; } .controls button { font-size:12px; }
    .keyboard { display:grid; gap:6px; border-top:1px solid var(--rule); padding-top:8px; } .keyboard select { width:100%; min-height:32px; border:1px solid var(--rule); border-radius:0; background:var(--paper); padding:4px; }
    .popover { width:390px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; display:grid; gap:12px; overscroll-behavior:contain; }
    .close { padding:2px 7px; min-height:28px; font-size:16px; } .verdict { padding:8px 10px; border:1px solid var(--verdict-color,var(--muted)); background:color-mix(in oklab,var(--verdict-color,var(--muted)) 8%,var(--plate)); }
    [data-decision="SUPPORTED"] { --verdict-color:var(--green); } [data-decision="REFUTED"] { --verdict-color:var(--red); }
    .verdict strong { display:block; color:var(--verdict-color,var(--muted)); font-size:18px; letter-spacing:-.025em; } .confidence { margin-top:4px; font-size:12px; }
    blockquote { padding-left:10px; border-left:2px solid var(--rule); white-space:pre-wrap; } .claim { max-height:150px; overflow:auto; } mark { background:color-mix(in oklab,var(--red) 14%,var(--plate)); color:var(--ink); border-bottom:2px solid var(--red); }
    .sources,.deep,.correction,.evidence { display:grid; gap:8px; } .sources ul,.deep ol { list-style:none; padding:0; border-top:2px solid var(--ink); } .sources li,.deep li { padding:8px 0; border-bottom:1px solid var(--rule); } .sources a { font-weight:500; } .sources .host { display:block; font:11px/1.4 ui-monospace,"SF Mono",Consolas,monospace; color:var(--muted); }
    .deep { border-top:1px solid var(--rule); padding-top:10px; } .deep p { white-space:pre-wrap; } .notice { background:var(--paper-2); padding:8px; font-size:12px; } .evidence { font-size:13px; } .evidence a { font-size:12px; } .unverified { font-size:13px; } .unverified summary { cursor:pointer; font-weight:600; } .unverified ul { padding-left:18px; margin-top:6px; } .unverified li { margin-top:5px; }
    .sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    @media(max-width:430px) { .guide { right:10px; bottom:10px; } .popover { width:calc(100vw - 24px); } }
    @media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function button(text, action, className = "quiet") {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function label(sentence) {
    if (sentence.status === "failed") return "! Check failed";
    if (sentence.status === "stopped") return "Ⅱ Stopped before checking";
    if (sentence.status !== "done") return sentence.status === "running" ? "◌ Checking…" : "◌ Pending";
    if (sentence.result?.decision === "SUPPORTED") return "✓ Supported";
    if (sentence.result?.decision === "REFUTED") return "× Refuted";
    return "Can't be confirmed from Wikipedia";
  }
  function sourceLink(source, title) {
    let url;
    try { url = new URL(source); } catch { return element("span", null, source || "Unknown source"); }
    if (!["https:", "http:"].includes(url.protocol)) return element("span", null, source);
    let name = title;
    if (!name) {
      try { name = decodeURIComponent(url.pathname.split("/wiki/")[1] || url.hostname).replace(/_/g, " "); }
      catch { name = url.hostname; }
    }
    const link = element("a", null, name);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }
  function quoteWithCorrections(text, errors) {
    const quote = element("blockquote", "claim");
    const chars = Array.from(text || "");
    const ranges = (Array.isArray(errors) ? errors : []).filter(error =>
      Number.isInteger(error.start) && Number.isInteger(error.end) && error.start >= 0 &&
      error.end > error.start && error.end <= chars.length &&
      chars.slice(error.start, error.end).join("") === error.original_text
    ).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const error of ranges) {
      if (error.start < cursor) continue;
      quote.append(document.createTextNode(chars.slice(cursor, error.start).join("")),
        element("mark", null, chars.slice(error.start, error.end).join("")));
      cursor = error.end;
    }
    quote.append(document.createTextNode(chars.slice(cursor).join("")));
    return quote;
  }

  function create(callbacks = {}) {
    const host = element("div");
    host.dataset.wikifactUi = "true";
    host.dataset.wfcUi = "true";
    // Inline !important prevents broad page styles from repositioning the UI host.
    host.style.cssText = 'all:initial!important;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif!important;color:oklch(16% .006 60)!important;color-scheme:light!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    const shadow = host.attachShadow({ mode: "open" });
    // Constructed stylesheets keep the extension UI styled on pages with strict style-src.
    // Older browsers can still use the ordinary shadow-root stylesheet fallback.
    try {
      if (!("adoptedStyleSheets" in shadow)) throw new Error("Constructed stylesheets are unavailable.");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = element("style");
      style.textContent = STYLE;
      shadow.append(style);
    }
    const guide = element("section", "guide");
    guide.setAttribute("aria-label", "Page fact-check controls");
    const guideHead = element("div", "guide-head");
    guideHead.append(element("h2", null, "Wikipedia fact check"));
    const guideBody = element("div");
    guideBody.style.cssText = "display:grid;gap:8px";
    const toggle = button("Minimize", () => {
      guideBody.hidden = !guideBody.hidden;
      toggle.textContent = guideBody.hidden ? "Expand" : "Minimize";
      toggle.setAttribute("aria-expanded", String(!guideBody.hidden));
      // Expanding the guide on a small screen returns focus to its controls.
      if (!guideBody.hidden && pinned) hide();
      else clamp();
    });
    toggle.setAttribute("aria-expanded", "true");
    const closeGuide = button("×", () => {
      if (callbacks.onClear) callbacks.onClear();
      else destroy();
    }, "quiet close");
    closeGuide.setAttribute("aria-label", "Close page fact-check overlay");
    closeGuide.title = "Close page fact-check overlay";
    const guideActions = element("div", "guide-actions");
    guideActions.append(toggle, closeGuide);
    guideHead.append(guideActions);
    const progressText = element("p", "muted", "Preparing article…");
    const progress = element("progress");
    progress.setAttribute("aria-label", "Fast check progress");
    const legend = element("div", "legend");
    for (const [color, text] of [["green", "Supported"], ["red", "Refuted"], ["", "Uncertain"]]) {
      const item = element("span");
      item.append(element("i", "dot " + color), document.createTextNode(text));
      legend.append(item);
    }
    const notice = element("p", "muted");
    const controls = element("div", "controls");
    const stop = button("Stop", () => callbacks.onStop?.());
    const clear = button("Clear", () => callbacks.onClear?.());
    const rescan = button("Rescan", () => callbacks.onRescan?.());
    const retry = button("Retry failed", () => callbacks.onRetry?.());
    retry.hidden = true;
    controls.append(stop, clear, rescan, retry);
    const keyboard = element("div", "keyboard");
    const select = element("select");
    select.setAttribute("aria-label", "Choose an article sentence");
    const keyboardRow = element("div", "controls");
    const previous = button("← Previous", () => browse(-1));
    const next = button("Next →", () => browse(1));
    const inspect = button("Open result", () => openSelected(true));
    keyboardRow.append(previous, next, inspect);
    keyboard.append(select, keyboardRow);
    select.addEventListener("change", () => openSelected());
    guideBody.append(progressText, progress, legend, notice, controls, keyboard);
    guide.append(guideHead, guideBody);
    const popover = element("section", "popover");
    popover.hidden = true;
    popover.tabIndex = -1;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Sentence fact-check result");
    const live = element("div", "sr");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    shadow.append(guide, popover, live);
    document.documentElement.append(host);
    let sentences = [], current = null, pinned = false, hideTimer, destroyed = false, autoCollapsed = false;
    let position = { x: 12, y: 12 }, lastGuideState = "", optionIds = "", renderKey = "", announcedSentenceState = "";

    function announce(text) { if (live.textContent !== text) live.textContent = text; }
    function cancelHide() { clearTimeout(hideTimer); }
    function scheduleHide() { cancelHide(); if (!pinned) hideTimer = setTimeout(hide, 220); }
    function hide() {
      cancelHide(); popover.hidden = true; current = null; pinned = false; renderKey = ""; announcedSentenceState = "";
      if (autoCollapsed) {
        guideBody.hidden = false; toggle.textContent = "Minimize"; toggle.setAttribute("aria-expanded", "true");
        autoCollapsed = false;
      }
    }
    popover.addEventListener("pointerenter", cancelHide);
    popover.addEventListener("pointerleave", scheduleHide);
    function onKey(event) {
      if (event.key === "Escape" && !popover.hidden) {
        event.preventDefault();
        const restore = shadow.activeElement && popover.contains(shadow.activeElement);
        hide();
        if (restore) inspect.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    function clamp() {
      if (popover.hidden || destroyed) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      popover.style.maxHeight = Math.max(56, viewportHeight - 24) + "px";
      const width = popover.offsetWidth;
      let x = Math.max(left + 12, Math.min(position.x, left + viewportWidth - width - 12));
      let bottom = top + viewportHeight - 12;
      // A pinned analysis must leave the scan controls reachable, including on phones.
      if (pinned) {
        let guideRect = guide.getBoundingClientRect();
        if (x + width > guideRect.left - 12 && x < guideRect.right + 12) {
          if (guideRect.left - left >= width + 24) x = guideRect.left - width - 12;
          else {
            if (guideRect.top - top < 144 && !guideBody.hidden) {
              guideBody.hidden = true; toggle.textContent = "Expand"; toggle.setAttribute("aria-expanded", "false");
              autoCollapsed = true;
              guideRect = guide.getBoundingClientRect();
            }
            bottom = guideRect.top - 12;
            popover.style.maxHeight = Math.max(56, bottom - top - 12) + "px";
          }
        }
      }
      const height = popover.offsetHeight;
      popover.style.left = x + "px";
      popover.style.top = Math.max(top + 12, Math.min(position.y, bottom - height)) + "px";
    }
    window.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("resize", clamp);

    function browse(direction) {
      if (!sentences.length) return;
      const index = Math.max(0, sentences.findIndex(item => item.id === select.value));
      select.value = sentences[(index + direction + sentences.length) % sentences.length].id;
      openSelected();
    }
    function openSelected(startAnalysis = false) {
      const sentence = sentences.find(item => item.id === select.value);
      if (!sentence) return;
      sentence.range?.startContainer?.parentElement?.scrollIntoView?.({ block: "center", behavior: "instant" });
      show(sentence, { pinned: true });
      if (startAnalysis && sentence.status === "done") callbacks.onSelect?.(sentence.id);
      popover.focus({ preventScroll: true });
    }
    function analyze() {
      if (!current || current.status !== "done") return;
      pinned = true;
      callbacks.onSelect?.(current.id);
    }
    function evidence(container, items) {
      for (const item of Array.isArray(items) ? items : []) {
        const section = element("div", "evidence");
        if (item.quote || item.paragraph) section.append(element("blockquote", null, item.quote || item.paragraph));
        if (item.source || item.url) section.append(sourceLink(item.source || item.url, item.title));
        container.append(section);
      }
    }
    function renderDeep(deep) {
      const section = element("div", "deep");
      section.append(element("h3", null, "Deeper analysis"));
      if (["loading", "pending"].includes(deep.status)) {
        section.append(element("p", "muted", "◌ Analyzing this sentence and Wikipedia evidence…"));
        section.setAttribute("aria-busy", "true");
        // Partial evidence may arrive before the completed explanation.
        evidence(section, deep.paragraphs);
        return section;
      }
      if (deep.status === "error") {
        section.append(element("p", "error", deep.error || "Deeper analysis failed."));
        return section;
      }
      if (deep.explanation) section.append(element("p", null, typeof deep.explanation === "string" ? deep.explanation : JSON.stringify(deep.explanation)));
      if (deep.incomplete) section.append(element("p", "notice", "Some facts could not be assessed. This analysis is incomplete."));
      const errors = Array.isArray(deep.errors) ? deep.errors : [];
      if (errors.length) {
        const list = element("ol");
        errors.forEach((error, index) => {
          const item = element("li", "correction");
          item.append(element("h3", null, `Correction ${index + 1}`), element("blockquote", null, error.original_text || ""));
          if (error.explanation) item.append(element("p", null, error.explanation));
          if (error.correction || error.corrected_text) item.append(element("p", null, "Correction: " + (error.correction || error.corrected_text)));
          evidence(item, error.evidence);
          list.append(item);
        });
        section.append(list);
      }
      evidence(section, deep.paragraphs);
      const unverified = Array.isArray(deep.unverified_facts) ? deep.unverified_facts : [];
      if (unverified.length) {
        const details = element("details", "unverified");
        details.append(element("summary", null, `Unverified facts (${unverified.length})`));
        const list = element("ul");
        for (const fact of unverified) list.append(element("li", null, [fact.text, fact.reason].filter(Boolean).join(" — ")));
        details.append(list);
        section.append(details);
      }
      if (!deep.explanation && !errors.length && !deep.paragraphs?.length && !unverified.length)
        section.append(element("p", "muted", "No additional Wikipedia evidence was found. The fast verdict is not independent evidence."));
      return section;
    }
    function renderPopover(guideAnnouncement = "") {
      if (!current) return;
      const sentenceState = JSON.stringify([current.id, current.status, current.result?.decision, current.error,
      current.deep?.status, current.deep?.error, current.deep?.incomplete]);
      let sentenceAnnouncement = "";
      if (sentenceState !== announcedSentenceState) {
        announcedSentenceState = sentenceState;
        sentenceAnnouncement = "Sentence result: " + label(current).replace(/^[✓×?◌!Ⅱ]\s*/, "").replace(/…$/, "") + ".";
        if (current.deep?.status === "done") sentenceAnnouncement += " Deeper analysis complete.";
        else if (current.deep?.status === "error") sentenceAnnouncement += " Deeper analysis failed. " + (current.deep.error || "Please try again later.");
        else if (["pending", "loading"].includes(current.deep?.status)) sentenceAnnouncement += " Deeper analysis is running.";
        if (current.status === "failed" && current.error) sentenceAnnouncement += " " + current.error;
      }
      const announcements = [guideAnnouncement, sentenceAnnouncement].filter(Boolean);
      if (announcements.length) announce(announcements.join(" "));
      // Unrelated sentence completions must not reset links, focus, or the reader's scroll.
      const nextKey = JSON.stringify([current.id, current.text, current.status, current.error, current.result, current.deep, pinned]);
      if (nextKey === renderKey) { clamp(); return; }
      renderKey = nextKey;
      const oldFocus = shadow.activeElement?.dataset?.focus;
      const scrollTop = popover.scrollTop;
      popover.replaceChildren();
      popover.dataset.decision = current.result?.decision || "";
      const head = element("div", "row");
      head.append(element("h2", null, pinned ? "Sentence analysis" : "Fast result"));
      const close = button("×", hide, "quiet close");
      close.setAttribute("aria-label", "Close sentence result (Escape)");
      close.dataset.focus = "close";
      head.append(close);
      const verdict = element("div", "verdict");
      verdict.append(element("strong", null, label(current)));
      const confidence = current.result?.confidence;
      if (typeof confidence === "number" && Number.isFinite(confidence))
        verdict.append(element("p", "confidence", `Confidence: ${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`));
      popover.append(head, verdict, quoteWithCorrections(current.text, current.deep?.errors));
      if (current.status === "failed") popover.append(element("p", "error", current.error || "The fast check failed. Use Retry failed in the guide."));
      if (current.status === "done") {
        const sources = element("div", "sources");
        sources.append(element("h3", null, "Wikipedia sources"));
        const urls = Array.isArray(current.result?.sources) ? current.result.sources : [];
        if (urls.length) {
          const list = element("ul");
          for (const url of urls) { const item = element("li"); item.append(sourceLink(url)); list.append(item); }
          sources.append(list);
        } else sources.append(element("p", "muted", "No sufficiently relevant source was found."));
        popover.append(sources);
        if (current.deep) popover.append(renderDeep(current.deep));
        else {
          const action = button("Click for deeper analysis", analyze, "");
          action.dataset.focus = "analyze";
          popover.append(action);
          if (!pinned) popover.append(element("p", "muted", "Click the highlighted sentence to pin this result."));
        }
      }
      if (oldFocus) popover.querySelector(`[data-focus="${oldFocus}"]`)?.focus({ preventScroll: true });
      popover.scrollTop = scrollTop;
      clamp();
    }
    function show(sentence, options = {}) {
      if (destroyed || (pinned && !options.pinned && current?.id !== sentence.id)) return;
      cancelHide();
      const same = current?.id === sentence.id;
      current = sentence;
      pinned = Boolean(options.pinned || (same && pinned));
      if (Number.isFinite(options.x) && Number.isFinite(options.y)) position = { x: options.x + 12, y: options.y + 16 };
      else if (!same) {
        const rect = sentence.range?.getBoundingClientRect?.();
        position = { x: rect?.left || 12, y: (rect?.bottom || 12) + 12 };
      }
      popover.hidden = false;
      renderPopover();
    }
    function update(nextSentences = [], meta = {}) {
      if (destroyed) return;
      sentences = nextSentences;
      const total = meta.total ?? sentences.length;
      const completed = meta.completed ?? sentences.filter(item => item.status === "done" || item.status === "failed").length;
      const failed = meta.failed ?? sentences.filter(item => item.status === "failed").length;
      progress.max = Math.max(1, total);
      progress.value = completed;
      const summary = `${completed} / ${total} checked${failed ? ` · ${failed} failed` : ""}${meta.stopped ? " · stopped" : ""}`;
      progressText.textContent = summary;
      const guideState = JSON.stringify([summary, meta.error || "", Boolean(meta.changed)]);
      const guideAnnouncement = guideState !== lastGuideState ? [summary,
        meta.error, meta.changed ? "Article changed. Select Rescan to check the current content." : ""].filter(Boolean).join(". ") : "";
      lastGuideState = guideState;
      stop.disabled = meta.stopped || completed >= total;
      retry.hidden = !failed;
      notice.textContent = meta.error || (meta.changed ? "Article changed. Select Rescan to check the current content." : "Newly loaded content is checked only after Rescan. ◌ Pending · ? Uncertain · ! Failed");
      notice.className = meta.error ? "error" : "muted";
      const ids = sentences.map(item => item.id).join("\n");
      const selected = select.value;
      if (ids !== optionIds) {
        select.replaceChildren(...sentences.map((sentence, index) => {
          const option = element("option");
          option.value = sentence.id;
          option.textContent = `${index + 1}. ${label(sentence)} · ${sentence.text.slice(0, 90)}`;
          return option;
        }));
        if (sentences.some(item => item.id === selected)) select.value = selected;
        optionIds = ids;
      } else {
        sentences.forEach((sentence, index) => { select.options[index].textContent = `${index + 1}. ${label(sentence)} · ${sentence.text.slice(0, 90)}`; });
      }
      select.disabled = previous.disabled = next.disabled = inspect.disabled = !sentences.length;
      if (current) {
        const refreshed = sentences.find(item => item.id === current.id);
        if (!refreshed) { hide(); if (guideAnnouncement) announce(guideAnnouncement); }
        else { current = refreshed; renderPopover(guideAnnouncement); }
      } else if (guideAnnouncement) announce(guideAnnouncement);
    }
    function destroy() {
      destroyed = true;
      cancelHide();
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", clamp);
      window.visualViewport?.removeEventListener("resize", clamp);
      host.remove();
    }
    return {
      update, show, hide, destroy, scheduleHide, cancelHide, isPinned: () => pinned,
      contains: target => target === host || shadow.contains(target), host
    };
  }
  globalThis.WikiFactPageUI = Object.freeze({ create });
})();
