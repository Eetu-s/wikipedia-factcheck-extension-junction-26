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
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.matches(".scan-word, .scan-letter")) {
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

    const loading = page.locator("[data-wfc-ui] .sentence-loading");
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
          listener({ type: "WFC_FAST_ITEM", scanId: request.message.scanId, sentenceId: request.message.sentenceId, answer }, {}, () => {});
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
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-loading").length === 3);
    assert.equal(await reveals.count(), 0, "loading never starts a verdict hop");
    const shimmer = await page.evaluate(() => animationRecords.filter(record => record.target.matches(".scan-word")).map(({ animation, target }) => ({
      frames: animation.effect.getKeyframes(),
      timing: animation.effect.getTiming(),
      gradient: getComputedStyle(target).backgroundImage,
      overlayHidden: target.closest(".sentence-loading").getAttribute("aria-hidden"),
      pointerEvents: getComputedStyle(target).pointerEvents,
    })));
    assert.ok(shimmer.length > 5, "visible loading text gets a shimmer");
    for (const word of shimmer) {
      assert.equal(word.timing.iterations, Infinity, "loading continues until the answer arrives");
      assert.ok(word.gradient.includes("gradient"), "loading uses a lighter/darker text gradient");
      assert.ok(word.frames.every(frame => !frame.transform || frame.transform === "none"), "loading text stays in place");
      const positions = word.frames.map(frame => parseFloat(frame.backgroundPosition || frame.backgroundPositionX));
      assert.ok(positions.at(-1) > positions[0], "the brightness front travels left to right");
      assert.equal(word.overlayHidden, "true", "visual loading copies are not announced twice");
      assert.equal(word.pointerEvents, "none", "loading preserves links and text selection");
    }

    await finish("Eiffel Tower");
    await reveals.waitFor({ state: "attached" });
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
      const records = animationRecords.filter(record => overlay.contains(record.target));
      const glyphs = records.filter(record => record.target.textContent.trim()).map(({ animation, target }) => {
        const range = document.createRange();
        range.selectNodeContents(target.querySelector(".scan-glyph"));
        const rect = range.getBoundingClientRect();
        return { text: target.textContent, rect: rect.toJSON(), delay: animation.effect.getTiming().delay };
      });
      const lines = [...new Set(glyphs.map(glyph => Math.round(glyph.rect.top)))].map(top => glyphs.filter(glyph => Math.round(glyph.rect.top) === top));
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
        rightToLeft: lines.every(line => {
          const ordered = line.toSorted((a, b) => a.rect.left - b.rect.left);
          return ordered.every((glyph, i) => !i || glyph.delay <= ordered[i - 1].delay);
        }),
        staggered: new Set(glyphs.map(glyph => glyph.delay)).size > 10,
      };
    });
    assert.ok(motion.duration >= 250 && motion.duration <= 500, "each letter makes a short hop");
    assert.equal(motion.peakTransform, "matrix(1, 0, 0, 1, 0, -4)");
    assert.ok(motion.frames.some(frame => frame.backgroundColor === "rgba(0, 0, 0, 0)" || frame.backgroundColor === "transparent"), "the result begins without a verdict tint");
    assert.ok(motion.frames.some(frame => frame.backgroundColor && !["rgba(0, 0, 0, 0)", "transparent"].includes(frame.backgroundColor)), "the verdict tint arrives with the hop");
    assert.ok(motion.glyphCount > 50 && motion.lineCount >= 3 && motion.aligned, "multiline letters retain their original glyph positions");
    assert.ok(motion.rightToLeft && motion.staggered, "the verdict sweeps right to left through separately delayed letters");
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
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-loading").length === 2);

    // Concurrent results retain independent overlays and source hiding.
    await start();
    await finish("Eiffel Tower");
    await finish("Helsinki", "REFUTED");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-reveal").length === 2);
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-refuted")?.size || 0), 0, "the refuted highlight waits for its reveal");
    const refutedFrames = await page.evaluate(() => animationRecords.find(({ target }) => target.closest(".sentence-reveal")?.textContent.includes("Helsinki")).animation.effect.getKeyframes());
    assert.ok(refutedFrames.some(frame => frame.backgroundColor === "rgba(181, 54, 45, 0.2)"), "refuted letters reveal the red verdict tint");
    await finishReveal("Eiffel");
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-reveal").length === 1);
    assert.ok(await page.evaluate(() => CSS.highlights.get("wfc-animating").size > 0), "finishing one verdict preserves the others' source hiding");
    await page.waitForFunction(() => CSS.highlights.get("wfc-supported")?.size > 0);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await reveals.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-loading").length === 1);
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
    console.log("Sentence animation passed: left-to-right loading shimmer, right-to-left per-letter verdict hops, inline/multiline typography, unchanged source/layout, concurrent results, no replay, viewport rebuilds, offscreen/reduced-motion skips, stop/clear/invalidation cleanup.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
