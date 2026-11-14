/* Injected only by the page context-menu command. The article is a fixed snapshot;
 * mutation observers invalidate it but never enqueue newly loaded text. */
(() => {
  if (globalThis.WikiFactPageScan) return;
  // Independent requests refill immediately; no sentence waits for a batch or stream.
  const INITIAL_CONCURRENCY = 2;
  const MAX_CONCURRENCY = 4;
  const MAX_RETRIES = 3;
  const names = ["pending", "supported", "refuted", "uncertain", "failed"];
  let scan = null;
  let starting = 0;
  let renderFrame = 0;
  let priorityFrame = 0;
  let hoverFrame = 0;
  let wakeTimer = 0;

  const send = (type, extra = {}, current = scan) => chrome.runtime.sendMessage({
    type, scanId: current?.id, ...extra,
  });
  const live = (current) => scan === current && !current.invalid && location.href === current.url;
  const valid = (sentence) => sentence.isValid ? sentence.isValid() :
    sentence.range.startContainer.isConnected && sentence.range.endContainer.isConnected;
  const ranges = (sentence) => sentence.ranges || [sentence.range];
  const groupOf = (sentence) => sentence.status === "failed" ? "failed" : sentence.status !== "done" ? "pending" :
    sentence.result.decision === "SUPPORTED" ? "supported" :
      sentence.result.decision === "REFUTED" ? "refuted" : "uncertain";

  function refresh(sentence) {
    if (sentence && scan) scan.dirty.add(sentence);
    if (!scan || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (!scan) return;
      const current = scan;
      const changed = [...current.dirty];
      current.dirty.clear();
      for (const sentence of changed) {
        const completed = sentence.status === "done" || sentence.status === "failed";
        current.completed += Number(completed) - Number(sentence.paintedComplete || false);
        current.failed += Number(sentence.status === "failed") - Number(sentence.paintedFailed || false);
        sentence.paintedComplete = completed;
        sentence.paintedFailed = sentence.status === "failed";
        if (!current.highlights || current.invalid) continue;
        const group = groupOf(sentence);
        if (sentence.highlightGroup === group) continue;
        for (const range of ranges(sentence)) {
          if (sentence.highlightGroup) current.highlights[sentence.highlightGroup].delete(range);
          current.highlights[group].add(range);
        }
        sentence.highlightGroup = group;
      }
      current.ui.update(current.sentences, {
        total: current.sentences.length, completed: current.completed, failed: current.failed,
        stopped: current.stopped, changed: current.changed,
        error: current.error || (current.failed ? current.failureMessage : ""),
        changedSentences: changed,
      });
      // Verdicts paint immediately. Decorative hops share a small frame budget during bursts.
      const deadline = performance.now() + 4;
      let animated = 0;
      for (const sentence of current.animations) {
        current.animations.delete(sentence);
        if (!current.invalid && !current.stopped) current.ui.animateSentence(sentence);
        if (++animated >= 3 || performance.now() >= deadline) break;
      }
      if (current.animations.size) refresh();
    });
  }

  function invalidate(current, message) {
    if (scan !== current || current.invalid) return;
    current.invalid = true;
    current.changed = true;
    current.error = message;
    current.observer?.disconnect();
    clearInterval(current.navigationTimer);
    stop(current);
    current.ui.hide();
    for (const name of names) globalThis.CSS?.highlights?.delete("wfc-" + name);
    refresh();
  }

  function stop(current = scan) {
    if (!current) return;
    current.stopped = true;
    current.ui.clearAnimations();
    current.animations.clear();
    current.queue.length = 0;
    current.queued.clear();
    clearTimeout(wakeTimer);
    current.cancelFast = send("WFC_SCAN_CANCEL", { kind: "fast" }, current).catch(() => {});
    for (const sentence of current.sentences) {
      if (["pending", "running"].includes(sentence.status)) {
        sentence.version++;
        sentence.status = "stopped";
        current.dirty.add(sentence);
      }
    }
    refresh();
  }

  async function clear(cancelStart = true) {
    if (cancelStart) starting++;
    const old = scan;
    scan = null;
    clearTimeout(wakeTimer);
    cancelAnimationFrame(renderFrame);
    cancelAnimationFrame(priorityFrame);
    cancelAnimationFrame(hoverFrame);
    renderFrame = hoverFrame = priorityFrame = 0;
    if (!old) return;
    old.invalid = true;
    old.observer?.disconnect();
    clearInterval(old.navigationTimer);
    old.ui.destroy();
    old.style.remove();
    for (const name of names) globalThis.CSS?.highlights?.delete("wfc-" + name);
    await send("WFC_SCAN_CANCEL", {}, old).catch(() => {});
  }

  function dismissSentence() {
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    scan?.ui.hide();
  }

  function closeOnNavigation() {
    if (scan && location.href !== scan.url) clear();
  }

  function enqueue(current, sentence) {
    if (current.queued.has(sentence)) return;
    current.queued.add(sentence);
    current.queue.push(sentence);
    current.priorityDirty = true;
  }

  function prioritize(current) {
    if (!current.priorityDirty) return;
    current.priorityDirty = false;
    // Read geometry once per queued sentence after scrolling, never inside a sort comparator.
    const positions = new Map(current.queue.map((sentence) => {
      const rect = sentence.range.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      return [sentence, { visible, distance: Math.max(0, -rect.bottom, rect.top - innerHeight) }];
    }));
    current.queue.sort((a, b) => Number(positions.get(b).visible) - Number(positions.get(a).visible) ||
      positions.get(a).distance - positions.get(b).distance || a.index - b.index);
  }

  function pump(current = scan) {
    if (!current || !live(current) || current.stopped) return;
    clearTimeout(wakeTimer);
    const now = Date.now();
    if (current.cooldown > now) {
      wakeTimer = setTimeout(() => pump(current), current.cooldown - now);
      return;
    }
    // A completed sentence paints independently; its callback immediately frees a slot.
    if (current.active >= current.concurrency) { refresh(); return; }
    prioritize(current);
    const ready = [], deferred = [];
    const slots = current.concurrency - current.active;
    current.queue = current.queue.filter((sentence) => {
      if (sentence.status !== "pending") { current.queued.delete(sentence); return false; }
      if (sentence.retryAt <= now && ready.length < slots) {
        ready.push(sentence);
        current.queued.delete(sentence);
        return false;
      }
      if (sentence.retryAt > now) deferred.push(sentence.retryAt);
      return true;
    });
    while (ready.length) {
      const sentence = ready.shift();
      if (!valid(sentence)) {
        invalidate(current, "Article text changed. Choose Rescan to check the current content.");
        return;
      }
      sentence.status = "running";
      current.dirty.add(sentence);
      const version = ++sentence.version;
      current.active++;
      fastCheck(current, sentence, version).finally(() => {
        current.active--;
        if (live(current)) { refresh(); pump(current); }
      });
    }
    if (deferred.length) wakeTimer = setTimeout(() => pump(current), Math.max(1, Math.min(...deferred) - now));
    refresh();
  }

  async function fastCheck(current, sentence, version) {
    const startedAt = performance.now();
    let response;
    try {
      response = await send("WFC_FAST", {
        sentenceId: sentence.id, text: sentence.text, context: sentence.context,
      }, current);
    } catch (error) {
      response = { error: error.message, retryable: true };
    }
    applyFast(current, sentence, version, response, performance.now() - startedAt);
  }

  // One sentence's fast answer: { result }, { error, status, retryAfter } or { stale }.
  function applyFast(current, sentence, version, response, duration) {
    try {
      if (!live(current) || current.stopped || sentence.status !== "running" || sentence.version !== version) return;
      if (!valid(sentence)) return invalidate(current, "Article text changed. Choose Rescan.");
      if (response?.stale) return invalidate(current, "The page changed. Choose Rescan.");
      if (response?.error) {
        if (response.retryable) {
          current.concurrency = Math.max(INITIAL_CONCURRENCY, Math.floor(current.concurrency / 2));
          current.healthy = 0;
          if (sentence.attempts++ < MAX_RETRIES) {
            const delay = Math.max(response.retryAfter || 0, Math.min(15000, 1000 * 2 ** (sentence.attempts - 1)));
            current.cooldown = Math.max(current.cooldown, Date.now() + delay);
            sentence.status = "pending";
            sentence.retryAt = current.cooldown;
            enqueue(current, sentence);
            current.error = response.error + " Retrying with fewer checks…";
          } else {
            // Preserve completed results and leave the untouched queue available for Retry.
            sentence.status = "failed";
            sentence.error = current.failureMessage = response.error;
            current.error = response.error + " Scan paused. Choose Retry failed.";
            stop(current);
          }
          return;
        }
        if (response.status === 429 && sentence.attempts++ < MAX_RETRIES) {
          current.cooldown = Math.max(current.cooldown,
            Date.now() + Math.max(1000, response.retryAfter || 2000 * 2 ** sentence.attempts));
          sentence.status = "pending";
          sentence.retryAt = current.cooldown;
          enqueue(current, sentence);
          current.error = "Rate limit reached. Waiting before retrying…";
          return;
        }
        if (response.status === 401) {
          current.error = response.error;
          stop(current);
        }
        throw new Error(response.error);
      }
      const result = response?.result;
      if (!result?.check_id || !["SUPPORTED", "REFUTED", "NOT ENOUGH INFO"].includes(result.decision)) {
        throw new Error("The backend returned an invalid fast result. Update it, then retry.");
      }
      sentence.result = result;
      sentence.status = "done";
      // Grow only after sustained quick answers; slow backends keep the smaller window.
      if (duration < 5000) {
        if (++current.healthy >= 2) {
          current.concurrency = Math.min(MAX_CONCURRENCY, current.concurrency + 1);
          current.healthy = 0;
        }
      } else {
        current.healthy = 0;
        if (duration > 12000) current.concurrency = Math.max(INITIAL_CONCURRENCY, current.concurrency - 1);
      }
      if (current.cooldown <= Date.now()) current.error = "";
      current.animations.add(sentence);
    } catch (error) {
      if (!live(current) || sentence.version !== version || current.stopped && sentence.status !== "running") return;
      sentence.status = "failed";
      sentence.error = error.message;
      current.failureMessage = error.message;
    } finally {
      if (scan === current) refresh(sentence);
    }
  }

  async function retry() {
    const current = scan;
    if (!current || current.invalid) return;
    const cancellation = current.cancelFast;
    await cancellation;
    if (!live(current) || current.cancelFast !== cancellation) return;
    for (const sentence of current.sentences) {
      if (["failed", "stopped"].includes(sentence.status)) {
        sentence.status = "pending";
        sentence.version++;
        sentence.error = "";
        sentence.attempts = 0;
        sentence.retryAt = 0;
        current.dirty.add(sentence);
        enqueue(current, sentence);
      }
    }
    current.stopped = false;
    current.error = "";
    current.failureMessage = "";
    current.cooldown = 0;
    current.concurrency = INITIAL_CONCURRENCY;
    current.healthy = 0;
    pump(current);
  }

  async function analyze(id) {
    const current = scan;
    const sentence = current?.sentences.find((s) => s.id === id);
    if (!sentence || !live(current) || !valid(sentence) || sentence.status !== "done") return;
    current.ui.show(sentence, { pinned: true });
    if (sentence.deep) return; // Hover never starts analysis; repeated clicks reuse the same job.
    sentence.deep = { status: "loading" };
    refresh();
    const payload = { sentenceId: sentence.id, checkId: sentence.result.check_id };
    try {
      let response = await send("WFC_DEEP_START", payload, current);
      const deadline = Date.now() + 5 * 60 * 1000;
      while (live(current) && valid(sentence)) {
        if (response?.stale) return invalidate(current, "The page changed. Choose Rescan.");
        if (response?.error) throw new Error(response.error);
        if (!response?.result) throw new Error("No deeper analysis was returned.");
        sentence.deep = response.result;
        refresh();
        if (["done", "error"].includes(sentence.deep.status)) return;
        if (Date.now() > deadline) throw new Error("Deeper analysis took too long. Rescan to try again.");
        // Yield between short authenticated polls so the service worker may sleep safely.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!live(current) || !valid(sentence)) return;
        response = await send("WFC_DEEP_POLL", payload, current);
      }
    } catch (error) {
      if (!live(current)) return;
      sentence.deep = { status: "error", error: error.message };
      refresh();
    }
  }

  function sentenceAt(x, y) {
    if (!scan || scan.invalid) return null;
    const caret = document.caretPositionFromPoint?.(x, y);
    const legacy = !caret && document.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode || legacy?.startContainer;
    const offset = caret?.offset ?? legacy?.startOffset;
    if (!node) return null;
    for (const sentence of scan.byNode.get(node) || []) {
      if (!valid(sentence)) continue;
      if (!sentence.segments.some((segment) => segment.node === node && offset >= segment.start && offset <= segment.end)) continue;
      if (ranges(sentence).some((range) => [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom))) return sentence;
    }
    return null;
  }

  async function start() {
    const request = ++starting;
    await clear(false);
    if (request !== starting) return;
    let article, extractionError = "";
    try { article = WikiFactArticle.extract(document); }
    catch (error) {
      article = { sentences: [], root: document.body };
      extractionError = error.message;
    }
    const highlightCSS = `
      ::highlight(wfc-pending) { background-color: rgba(100,100,100,.09); text-decoration: underline dotted #777; }
      ::highlight(wfc-supported) { background-color: rgba(43,128,78,.19); text-decoration: underline #2b804e; }
      ::highlight(wfc-refuted) { background-color: rgba(181,54,45,.20); text-decoration: underline #b5362d; }
      ::highlight(wfc-uncertain) { background-color: rgba(100,100,100,.16); text-decoration: underline #777; }
      ::highlight(wfc-failed) { background-color: rgba(100,100,100,.10); text-decoration: underline wavy #777; }
      ::highlight(wfc-hopping) { color: transparent; text-shadow: none; }
    `;
    let style;
    if (globalThis.CSSStyleSheet?.prototype.replaceSync && "adoptedStyleSheets" in document) {
      // Constructed stylesheets work on articles with strict style-src CSP as well.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(highlightCSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      style = { remove: () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet); } };
    } else {
      style = document.createElement("style");
      style.dataset.wfcUi = "true";
      style.textContent = highlightCSS;
      document.documentElement.append(style);
    }
    const current = {
      id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      url: location.href, article, style, active: 0,
      cooldown: 0, stopped: false, invalid: false, changed: false, byNode: new WeakMap(),
      queue: [], queued: new Set(), priorityDirty: true, failureMessage: "",
      concurrency: INITIAL_CONCURRENCY, healthy: 0,
      dirty: new Set(), animations: new Set(), completed: 0, failed: 0,
      sentences: article.sentences.map((s, index) => ({ ...s, index, status: "pending", attempts: 0, retryAt: 0, version: 0 })),
    };
    scan = current;
    current.queue = current.sentences.slice();
    current.queued = new Set(current.sentences);
    current.dirty = new Set(current.sentences);
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      current.highlights = Object.fromEntries(names.map((name) => [name, new Highlight()]));
      for (const name of names) CSS.highlights.set("wfc-" + name, current.highlights[name]);
    }
    current.ui = WikiFactPageUI.create({ onStop: () => stop(), onClear: clear, onRescan: start, onRetry: retry, onSelect: analyze });
    for (const sentence of current.sentences) {
      for (const { node } of sentence.segments) {
        const list = current.byNode.get(node) || [];
        if (!list.includes(sentence)) list.push(sentence);
        current.byNode.set(node, list);
      }
    }
    if (!current.sentences.length) current.error = extractionError || "No readable article sentences found on this page.";
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) current.error = "Highlights require a recent Chrome version. Use the guide to browse sentence results.";
    refresh();
    // Text/context/visibility edits invalidate the snapshot. Appended blocks only mark it
    // changed: an explicit Rescan is required to extract them. Ignore extension UI churn.
    current.observer = new MutationObserver((mutations) => {
      if (!live(current)) return;
      const relevant = mutations.filter((m) => !m.target.parentElement?.closest("[data-wfc-ui]") &&
        !m.target.closest?.("[data-wfc-ui]"));
      if (!relevant.length) return;
      if (current.article.isValid ? !current.article.isValid() : current.sentences.some((s) => !valid(s))) {
        invalidate(current, "Article text changed. Choose Rescan to check the current content.");
      } else if (relevant.some((m) => m.type === "childList" && [...m.addedNodes].some((node) =>
        (node.textContent || "").trim() && (m.target === current.article.root || current.article.root?.contains(m.target))))) {
        current.changed = true;
        refresh();
      }
    });
    current.observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class", "contenteditable", "lang", "content", "datetime", "open"],
    });
    current.navigationTimer = setInterval(closeOnNavigation, 500);
    try {
      await send("WFC_SCAN_BEGIN", {}, current);
      if (live(current)) pump(current);
    } catch (error) {
      if (!live(current)) return;
      current.error = error.message;
      stop(current);
    }
  }

  document.addEventListener("pointermove", (event) => {
    if (!scan || scan.invalid || scan.ui.isPinned()) return;
    if (scan.ui.contains(event.target)) { scan.ui.cancelHide(); return; }
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const sentence = sentenceAt(event.clientX, event.clientY);
      if (sentence) scan?.ui.show(sentence, { x: event.clientX, y: event.clientY, pinned: false });
      else scan?.ui.scheduleHide();
    });
  }, { passive: true });
  document.addEventListener("click", (event) => {
    if (!scan || scan.invalid || scan.ui.contains(event.target) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const sentence = sentenceAt(event.clientX, event.clientY);
    if (!sentence) return;
    event.preventDefault();
    event.stopPropagation();
    scan.ui.show(sentence, { x: event.clientX, y: event.clientY, pinned: true });
    if (sentence.status === "done") analyze(sentence.id);
  }, true);
  window.addEventListener("scroll", () => {
    if (!scan || scan.stopped || scan.invalid) return;
    scan.priorityDirty = true;
    if (!priorityFrame) priorityFrame = requestAnimationFrame(() => { priorityFrame = 0; pump(); });
  }, { passive: true });
  window.addEventListener("resize", () => { if (scan) scan.priorityDirty = true; }, { passive: true });
  window.addEventListener("pagehide", () => { clear(); });
  window.addEventListener("popstate", closeOnNavigation);
  window.addEventListener("hashchange", closeOnNavigation);
  window.addEventListener("blur", dismissSentence);
  document.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget && event.pointerType !== "touch") dismissSentence();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "WFC_PAGE_START") { start(); return false; }
  });
  globalThis.WikiFactPageScan = { start, clear, stop, retry };
})();
