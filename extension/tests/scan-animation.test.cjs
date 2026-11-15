// Real browser coverage for loading shimmer, per-letter verdict waves, and cleanup.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    async function layoutCount() {
      return (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value;
    }
    await page.goto("about:blank");
    await page.setContent(`<html lang="en"><head><title>Landmarks</title>
      <style>article{width:340px;font:18px/1.6 Georgia,serif}a{color:rgb(30,80,160)}strong{font-weight:700}</style>
      </head><body><article>
      <p id="target">The <strong>Eiffel Tower</strong> in Paris was completed in <a href="https://example.org">1889</a> and remains a widely recognized landmark in France.</p>
      <p id="second">Helsinki is the capital of Finland.</p>
      <p id="third">Stockholm is the capital of Sweden.</p>
      <p id="offscreen" style="margin-top:1200px">Oslo is the capital of Norway.</p>
      </article></body></html>`);
    await page.evaluate(() => {
      window.mock = { requests: [], listeners: [], deepStarts: 0, nextId: 0 };
      window.animationRecords = [];
      window.canvasTrace = { fills: 0, ranges: 0, draws: [], gradients: [] };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        canvasTrace.fills++;
        return fillText.apply(this, args);
      };
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.matches(".loading-canvas")) canvasTrace.draws.push({ time: performance.now(), width: this.canvas.width, height: this.canvas.height });
        return drawImage.apply(this, args);
      };
      const gradientRecords = new WeakMap();
      const createLinearGradient = CanvasRenderingContext2D.prototype.createLinearGradient;
      CanvasRenderingContext2D.prototype.createLinearGradient = function (...args) {
        const gradient = createLinearGradient.apply(this, args);
        if (this.canvas.matches(".loading-canvas")) {
          const record = { coordinates: args, stops: [], time: performance.now() };
          gradientRecords.set(gradient, record);
          canvasTrace.gradients.push(record);
        }
        return gradient;
      };
      const addColorStop = CanvasGradient.prototype.addColorStop;
      CanvasGradient.prototype.addColorStop = function (...args) {
        gradientRecords.get(this)?.stops.push(args);
        return addColorStop.apply(this, args);
      };
      for (const method of ["getBoundingClientRect", "getClientRects"]) {
        const original = Range.prototype[method];
        Range.prototype[method] = function (...args) { canvasTrace.ranges++; return original.apply(this, args); };
      }
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.matches(".scan-word, .loading-wave, .loading-ink, .scan-letter, .scan-tint")) {
          animation.pause(); // Inspect every wave at a deterministic point in its timeline.
          animation.currentTime = 0;
          animationRecords.push({ animation, target: this });
        }
        return animation;
      };
      window.chrome = { runtime: {
        onMessage: { addListener(listener) { mock.listeners.push(listener); } },
        sendMessage: async (message) => {
          if (message.type === "WFC_FAST_BATCH") {
            const batch = { remaining: message.items.length, resolve: null };
            const complete = new Promise(resolve => { batch.resolve = resolve; });
            for (const item of message.items)
              mock.requests.push({ message: { ...message, ...item }, batch, finished: false });
            return complete;
          }
          if (message.type === "WFC_DEEP_START") {
            mock.deepStarts++;
            return { result: { status: "done", explanation: "Checked the stored evidence.", paragraphs: [], errors: [] } };
          }
          return {};
        },
      } };
      const article = document.querySelector("article");
      window.originalHTML = article.innerHTML;
      window.originalNodes = [];
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) originalNodes.push(walker.currentNode);
      window.originalBox = document.querySelector("#target").getBoundingClientRect().toJSON();
      window.originalGlyphs = [];
      const targetWalker = document.createTreeWalker(document.querySelector("#target"), NodeFilter.SHOW_TEXT);
      const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
      while (targetWalker.nextNode()) {
        const node = targetWalker.currentNode;
        for (const { segment, index } of segmenter.segment(node.data)) {
          if (!segment.trim()) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + segment.length);
          originalGlyphs.push({ text: segment, rect: range.getBoundingClientRect().toJSON() });
        }
      }
    });
    for (const file of ["vendor/Readability.js", "article.js", "page-ui.js", "page-scan.js"])
      await page.addScriptTag({ path: path.resolve(__dirname, "..", file) });

    const loading = page.locator("[data-wfc-ui] .loading-base .sentence-loading");
    const reveals = page.locator("[data-wfc-ui] .sentence-reveal");
    async function start() {
      await page.evaluate(async () => {
        await WikiFactPageScan.clear();
        mock.requests = [];
        animationRecords = [];
        await WikiFactPageScan.start();
      });
      await page.waitForFunction(() => mock.requests.length === 4);
    }
    async function finish(text, decision = "SUPPORTED") {
      await page.evaluate(({ text, decision }) => {
        const request = mock.requests.find(item => !item.finished && item.message.text.includes(text));
        if (!request) throw new Error("No pending request for " + text);
        request.finished = true;
        const answer = { result: { check_id: "animation-check-" + ++mock.nextId, decision, confidence: .9, sources: [] } };
        for (const listener of mock.listeners)
          listener({ type: "WFC_FAST_ITEM", scanId: request.message.scanId, batchId: request.message.batchId, sentenceId: request.message.sentenceId, answer }, {}, () => {});
        if (--request.batch.remaining === 0) request.batch.resolve({});
      }, { text, decision });
    }
    async function finishReveal(text) {
      await page.evaluate(text => {
        const shadow = document.querySelector("[data-wfc-ui]").shadowRoot;
        const overlay = [...shadow.querySelectorAll(".sentence-reveal")].find(node => node.textContent.includes(text));
        if (!overlay) throw new Error("No reveal for " + text);
        for (const { animation, target } of animationRecords)
          if (overlay.contains(target) && animation.playState !== "idle") animation.finish();
      }, text);
    }
    async function expectClean() {
      await page.waitForFunction(() => !CSS.highlights.has("wfc-animating"));
      assert.equal(await loading.count(), 0, "loading copies are removed with their source hiding");
      assert.equal(await reveals.count(), 0, "verdict copies are removed with their source hiding");
    }

    await start();
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".loading-base .sentence-loading").length === 3);
    assert.equal(await reveals.count(), 0, "loading never starts a verdict hop");
    await page.waitForFunction(() => canvasTrace.draws.length >= 2);
    const shimmer = await page.evaluate(() => {
      const stage = document.querySelector("[data-wfc-ui]").shadowRoot.querySelector(".loading-stage");
      const canvas = stage.querySelector(".loading-canvas");
      return {
        infiniteEffects: animationRecords.filter(({ animation }) => animation.effect.getTiming().iterations === Infinity && animation.playState !== "idle").length,
        words: stage.querySelectorAll(".loading-base .scan-word").length,
        overlayHidden: stage.getAttribute("aria-hidden"),
        pointerEvents: getComputedStyle(stage).pointerEvents,
        width: canvas.width, height: canvas.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
      };
    });
    assert.equal(shimmer.infiniteEffects, 0, "loading uses one cached canvas instead of independent word animations");
    assert.ok(shimmer.words > 5, "visible text shares the loading canvas");
    assert.equal(shimmer.overlayHidden, "true", "visual loading copies are not announced twice");
    assert.equal(shimmer.pointerEvents, "none", "loading preserves links and text selection");
    assert.ok(shimmer.width <= shimmer.viewportWidth * 2 && shimmer.height <= shimmer.viewportHeight * 2, "canvas backing pixels stay bounded on high-density screens");
    const steadyBefore = await page.evaluate(() => ({ fills: canvasTrace.fills, ranges: canvasTrace.ranges, draws: canvasTrace.draws.length, time: performance.now() }));
    await page.waitForTimeout(220);
    const steady = await page.evaluate(before => ({
      fills: canvasTrace.fills - before.fills,
      ranges: canvasTrace.ranges - before.ranges,
      frames: canvasTrace.draws.length - before.draws,
      elapsed: performance.now() - before.time,
      gradients: canvasTrace.gradients.slice(-8),
    }), steadyBefore);
    assert.equal(steady.fills, 0, "steady loading reuses cached text without rasterizing words again");
    assert.equal(steady.ranges, 0, "steady loading performs no text geometry reads");
    assert.ok(steady.frames >= 2 && steady.frames <= Math.ceil(steady.elapsed / (1000 / 30)) + 1, "canvas painting is throttled to at most 30 frames per second");
    for (const gradient of steady.gradients) {
      const [x0, y0, x1, y1] = gradient.coordinates;
      assert.ok(Math.abs(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI - 30) < .1, "the loading front slants at 30 degrees");
      const alpha = gradient.stops.map(([, color]) => Number(color.match(/,\s*([\d.]+)\)$/)?.[1] ?? 1));
      assert.deepEqual(alpha, [1, .51, 1], "peak whitening is 30% softer than the previous 70% lightening");
    }
    const motionRates = steady.gradients.slice(1).map((gradient, i) => (gradient.coordinates[0] - steady.gradients[i].coordinates[0]) / (gradient.time - steady.gradients[i].time)).toSorted((a, b) => a - b);
    const medianRate = motionRates[Math.floor(motionRates.length / 2)];
    assert.ok(medianRate > 0, "the brightness front travels left to right");
    const [x0, y0, x1, y1] = steady.gradients.at(-1).coordinates;
    const bandSpan = Math.hypot(x1 - x0, y1 - y0);
    const cos = (x1 - x0) / bandSpan, sin = (y1 - y0) / bandSpan;
    const inferredCycle = (shimmer.viewportWidth * cos + shimmer.viewportHeight * sin + bandSpan) * cos / medianRate;
    assert.ok(Math.abs(inferredCycle - 2000) < 180, "measured wave speed follows the 2000ms cycle, 20% slower than the previous sweep");
    if (process.env.SCAN_LOADING_SCREENSHOT) await page.screenshot({ path: process.env.SCAN_LOADING_SCREENSHOT });

    await page.evaluate(() => {
      window.changedOptions = [];
      window.optionObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          const option = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
          if (option.matches("option")) changedOptions.push(option.value);
        }
      });
      optionObserver.observe(document.querySelector("[data-wfc-ui]").shadowRoot.querySelector("select"), { subtree: true, childList: true, characterData: true });
    });
    const layoutsBeforeReveal = await layoutCount();
    await finish("Eiffel Tower");
    await reveals.waitFor({ state: "attached" });
    assert.ok(await layoutCount() - layoutsBeforeReveal < 16, "building a multiline result batches geometry instead of laying out once per letter");
    const optionUpdates = await page.evaluate(() => {
      optionObserver.disconnect();
      return { ids: [...new Set(changedOptions)], expected: mock.requests.find(request => request.message.text.includes("Eiffel Tower")).message.sentenceId };
    });
    assert.deepEqual(optionUpdates.ids, [optionUpdates.expected], "a streamed answer rewrites only its sentence menu label");
    assert.equal(await loading.count(), 2, "a completed sentence stops its loading shimmer");
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-supported")?.size || 0), 0, "the final tint stays hidden until the verdict wave finishes");
    const appearance = await reveals.evaluate(node => ({
      text: node.textContent,
      pointerEvents: getComputedStyle(node).pointerEvents,
      ariaHidden: node.getAttribute("aria-hidden"),
      colors: [...node.querySelectorAll(".scan-glyph")].map(child => getComputedStyle(child).color),
      weights: [...node.querySelectorAll(".scan-glyph")].map(child => getComputedStyle(child).fontWeight),
    }));
    assert.equal(appearance.text.replace(/\s+/g, ""), (await page.locator("#target").innerText()).replace(/\s+/g, ""));
    assert.equal(appearance.pointerEvents, "none", "verdict letters cannot intercept article links or selections");
    assert.equal(appearance.ariaHidden, "true", "the visual verdict copy is not announced twice");
    assert.ok(appearance.colors.includes("rgb(30, 80, 160)"), "link typography is preserved");
    assert.ok(appearance.weights.includes("700"), "bold typography is preserved");
    assert.deepEqual(await page.evaluate(() => ({
      html: document.querySelector("article").innerHTML === originalHTML,
      nodes: originalNodes.every(node => node.isConnected),
      box: document.querySelector("#target").getBoundingClientRect().toJSON(),
    })), { html: true, nodes: true, box: await page.evaluate(() => originalBox) }, "waves preserve source nodes and article layout");

    const motion = await page.evaluate(() => {
      const overlay = document.querySelector("[data-wfc-ui]").shadowRoot.querySelector(".sentence-reveal");
      const records = animationRecords.filter(record => overlay.contains(record.target) && record.target.matches(".scan-letter"));
      const glyphs = records.filter(record => record.target.textContent.trim()).map(({ animation, target }) => {
        const range = document.createRange();
        range.selectNodeContents(target.querySelector(".scan-glyph"));
        const rect = range.getBoundingClientRect();
        return { text: target.textContent, rect: rect.toJSON(), delay: animation.effect.getTiming().delay };
      });
      const lines = [...new Set(glyphs.map(glyph => Math.round(glyph.rect.top)))].map(top => glyphs.filter(glyph => Math.round(glyph.rect.top) === top));
      const firstLine = lines[0].toSorted((a, b) => a.rect.left - b.rect.left);
      const secondLine = lines[1].toSorted((a, b) => a.rect.left - b.rect.left);
      const horizontalRate = (firstLine.at(-1).delay - firstLine[0].delay) / (firstLine.at(-1).rect.left - firstLine[0].rect.left);
      const verticalRate = ((secondLine[0].delay - firstLine[0].delay) - horizontalRate * (secondLine[0].rect.left - firstLine[0].rect.left)) / (secondLine[0].rect.top - firstLine[0].rect.top);
      const animation = records.find(record => record.target.textContent.trim()).animation;
      const frames = animation.effect.getKeyframes();
      const timing = animation.effect.getTiming();
      const peak = frames.find(frame => frame.transform === "translateY(-4px)");
      animation.currentTime = timing.delay + timing.duration * peak.offset;
      return {
        duration: timing.duration,
        frames,
        peakTransform: getComputedStyle(animation.effect.target).transform,
        glyphCount: glyphs.length,
        aligned: glyphs.every((glyph, i) => glyph.text === originalGlyphs[i].text && Math.abs(glyph.rect.left - originalGlyphs[i].rect.left) < 1 && Math.abs(glyph.rect.top - originalGlyphs[i].rect.top) < 1),
        lineCount: lines.length,
        angle: Math.atan(verticalRate / horizontalRate) * 180 / Math.PI,
        leftToRight: lines.every(line => {
          const ordered = line.toSorted((a, b) => a.rect.left - b.rect.left);
          return ordered.every((glyph, i) => !i || glyph.delay >= ordered[i - 1].delay);
        }),
        staggered: new Set(glyphs.map(glyph => glyph.delay)).size > 10,
      };
    });
    assert.ok(motion.duration >= 250 && motion.duration <= 500, "each letter makes a short hop");
    assert.equal(motion.peakTransform, "matrix(1, 0, 0, 1, 0, -4)");
    const tint = await reveals.evaluate(node => {
      const target = node.querySelector(".scan-tint");
      const effect = animationRecords.find(record => record.target === target).animation.effect;
      return { color: getComputedStyle(target).backgroundColor, frames: effect.getKeyframes(), timing: effect.getTiming() };
    });
    assert.equal(tint.color, "rgba(43, 128, 78, 0.19)", "supported letters carry a static green tint");
    assert.ok(tint.frames.some(frame => frame.opacity === "0") && tint.frames.some(frame => frame.opacity === "1"), "the verdict tint fades in as its letter hops");
    assert.ok(tint.frames.every(frame => Object.keys(frame).every(key => ["offset", "computedOffset", "easing", "composite", "opacity"].includes(key))), "the tint animates opacity instead of repainting its background or shadow");
    assert.ok(motion.frames.every(frame => Object.keys(frame).every(key => ["offset", "computedOffset", "easing", "composite", "transform"].includes(key))), "the glyph hop animates transform only");
    assert.ok(motion.glyphCount > 50 && motion.lineCount >= 3 && motion.aligned, "multiline letters retain their original glyph positions");
    assert.ok(motion.leftToRight && motion.staggered, "the verdict sweeps left to right through separately delayed letters");
    assert.ok(Math.abs(motion.angle - 30) < 2, "the verdict wave follows the same 30 degree diagonal");
    if (process.env.SCAN_ANIMATION_SCREENSHOT) await page.screenshot({ path: process.env.SCAN_ANIMATION_SCREENSHOT });
    await finishReveal("Eiffel");
    await reveals.waitFor({ state: "detached" });
    await page.waitForFunction(() => CSS.highlights.get("wfc-supported")?.size > 0);
    assert.ok(await page.evaluate(() => CSS.highlights.get("wfc-animating")?.size > 0), "unanswered sentences keep shimmering after a verdict finishes");

    // Offscreen results and deeper analysis never replay a completed reveal.
    const revealCount = await page.evaluate(() => animationRecords.filter(record => record.target.matches(".scan-letter")).length);
    await finish("Oslo");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow") === "2");
    await page.locator("[data-wfc-ui] select").selectOption(await page.evaluate(() => mock.requests.find(item => item.message.text.includes("Eiffel Tower")).message.sentenceId));
    await page.getByRole("button", { name: "Open result", exact: true }).click();
    await page.waitForFunction(() => mock.deepStarts === 1);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    assert.equal(await page.evaluate(() => animationRecords.filter(record => record.target.matches(".scan-letter")).length), revealCount, "results animate once, including after deep analysis and scrolling");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".loading-base .sentence-loading").length === 2);

    // Concurrent results retain independent overlays and source hiding.
    await start();
    await finish("Eiffel Tower");
    await finish("Helsinki", "REFUTED");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-reveal").length === 2);
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-refuted")?.size || 0), 0, "the refuted highlight waits for its reveal");
    const refutedColor = await page.evaluate(() => getComputedStyle([...document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-reveal")].find(node => node.textContent.includes("Helsinki")).querySelector(".scan-tint")).backgroundColor);
    assert.equal(refutedColor, "rgba(181, 54, 45, 0.2)", "refuted letters reveal a static red verdict tint");

    await finishReveal("Eiffel");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-reveal").length === 1);
    assert.ok(await page.evaluate(() => CSS.highlights.get("wfc-animating").size > 0), "finishing one verdict preserves the others' source hiding");
    await page.waitForFunction(() => CSS.highlights.get("wfc-supported")?.size > 0);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await reveals.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".loading-base .sentence-loading").length === 1);
    await page.waitForFunction(() => CSS.highlights.get("wfc-refuted")?.size > 0);

    // Every scan exit restores all original text immediately.
    for (const action of ["stop", "clear", "invalidate"]) {
      await start();
      await finish("Eiffel Tower");
      await reveals.waitFor({ state: "attached" });
      await page.evaluate(action => {
        if (action === "stop") WikiFactPageScan.stop();
        if (action === "clear") WikiFactPageScan.clear();
        if (action === "invalidate") document.querySelector("#target").firstChild.data = "Changed source text ";
      }, action);
      await expectClean();
    }
    await page.evaluate(() => WikiFactPageScan.clear());
    await page.evaluate(() => { document.querySelector("article").innerHTML = originalHTML; });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await start();
    await finish("Eiffel Tower");
    await page.waitForFunction(() => CSS.highlights.get("wfc-supported")?.size > 0);
    assert.equal(await page.evaluate(() => animationRecords.length), 0, "reduced motion keeps loading and verdicts static");
    await expectClean();
    await page.evaluate(() => WikiFactPageScan.clear());

    // The cached canvas loader needs no fetched images, even on strict article CSPs.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      const csp = document.createElement("meta");
      csp.httpEquiv = "Content-Security-Policy";
      csp.content = "style-src 'none'; img-src 'none'";
      document.head.append(csp);
    });
    await start();
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".loading-base .sentence-loading").length === 3);
    assert.equal(await page.locator("[data-wfc-ui] .loading-canvas").count(), 1, "strict CSP preserves the loading canvas without fetching images");
    await page.evaluate(() => WikiFactPageScan.clear());
    await expectClean();

    const unsupported = await page.evaluate(async () => {
      const article = document.querySelector("article");
      const paragraph = document.createElement("p");
      paragraph.textContent = "Vertical text remains readable while checking.";
      paragraph.style.writingMode = "vertical-rl";
      article.replaceChildren(paragraph);
      const node = paragraph.firstChild, range = document.createRange();
      range.selectNodeContents(paragraph);
      const sentence = { id: "vertical", text: node.data, range, segments: [{ node, start: 0, end: node.length }], status: "running" };
      let changes = 0;
      const ui = WikiFactPageUI.create({ onAnimationChange() { changes++; ui.update([sentence]); } });
      ui.update([sentence]);
      for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      const result = { changes, overlays: ui.host.shadowRoot.querySelectorAll(".sentence-animation").length };
      ui.destroy();
      return result;
    });
    assert.equal(unsupported.overlays, 0, "unsupported writing modes retain their original text");
    assert.ok(unsupported.changes <= 1, "an unsupported loading candidate cannot trigger an endless refresh loop");

    const burst = await page.evaluate(async () => {
      const article = document.querySelector("article");
      article.replaceChildren();
      const sentences = Array.from({ length: 10 }, (_, i) => {
        const paragraph = document.createElement("p");
        paragraph.style.cssText = "font:12px/14px Georgia,serif;margin:0;width:850px";
        paragraph.textContent = `Sentence ${i} consists of carefully chosen letters for testing the concurrent animation budget.`;
        article.append(paragraph);
        const node = paragraph.firstChild, range = document.createRange();
        range.selectNodeContents(paragraph);
        return { id: String(i), text: node.data, range, segments: [{ node, start: 0, end: node.length }], status: "done", result: { decision: "SUPPORTED" } };
      });
      const ui = WikiFactPageUI.create({ onAnimationChange() { ui.update(sentences); } });
      ui.update(sentences);
      for (const sentence of sentences) ui.animateSentence(sentence);
      const seen = new Set();
      let maxLetters = 0, deferred = false;
      for (let pass = 0; pass < 10; pass++) {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const active = [...ui.host.shadowRoot.querySelectorAll(".sentence-reveal")];
        maxLetters = Math.max(maxLetters, ui.host.shadowRoot.querySelectorAll(".scan-letter").length);
        if (pass === 0) deferred = active.length < sentences.length;
        for (const overlay of active) {
          seen.add(sentences.find(sentence => sentence.text === overlay.textContent).id);
          for (const { target, animation } of animationRecords)
            if (overlay.contains(target) && animation.playState !== "idle") animation.finish();
        }
        await new Promise(requestAnimationFrame);
        if (sentences.every(sentence => !ui.isAnimating(sentence))) break;
      }
      const result = { maxLetters, deferred, seen: seen.size, settled: sentences.every(sentence => !ui.isAnimating(sentence)) };
      ui.destroy();
      return result;
    });
    assert.ok(burst.deferred && burst.maxLetters <= 600, "bursts defer excess sentences to keep active glyph layers bounded");
    assert.ok(burst.settled && burst.seen === 10, "every deferred sentence eventually receives its verdict wave");
    console.log("Sentence animation passed: shared diagonal loading shimmer, left-to-right per-letter verdict hops, batched layout, unchanged menu labels, inline/multiline typography, unchanged source/layout, bounded bursts, unsupported writing modes, no replay, viewport rebuilds, offscreen/reduced-motion skips, strict CSP, stop/clear/invalidation cleanup.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
