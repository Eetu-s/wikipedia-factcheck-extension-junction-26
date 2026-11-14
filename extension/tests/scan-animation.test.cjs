// Real browser coverage for the temporary sentence hop and scan lifecycle.
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
      window.mock = { requests: [], deepStarts: 0, nextId: 0 };
      window.hops = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.classList.contains("sentence-hop")) {
          animation.pause(); // Inspect the hop deterministically, without racing its 360ms lifetime.
          hops.push(animation);
        }
        return animation;
      };
      window.chrome = { runtime: {
        onMessage: { addListener(listener) { mock.onMessage = listener; } },
        sendMessage: async (message) => {
          if (message.type === "WFC_FAST") return new Promise(resolve => {
            const request = { message, finished: false };
            request.resolve = answer => {
              if (request.finished) return;
              request.finished = true;
              resolve(answer);
            };
            mock.requests.push(request);
          });
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
    });
    for (const file of ["vendor/Readability.js", "article.js", "page-ui.js", "page-scan.js"])
      await page.addScriptTag({ path: path.resolve(__dirname, "..", file) });

    const overlays = page.locator("[data-wfc-ui] .sentence-hop");
    async function start() {
      await page.evaluate(async () => {
        await WikiFactPageScan.clear();
        mock.requests = [];
        hops = [];
        await WikiFactPageScan.start();
      });
      await page.waitForFunction(() => mock.requests.some(request => request.message.text.includes("Eiffel Tower")));
    }
    async function finish(text, decision = "SUPPORTED") {
      await page.evaluate(({ text, decision }) => {
        const request = mock.requests.find(item => !item.finished && item.message.text.includes(text));
        if (!request) throw new Error("No pending request for " + text);
        request.resolve({ result: { check_id: "animation-check-" + ++mock.nextId, decision, confidence: .9, sources: [] } });
      }, { text, decision });
    }
    async function expectClean() {
      await page.waitForFunction(() => !CSS.highlights.has("wfc-hopping"));
      assert.equal(await overlays.count(), 0, "temporary text is removed with its hiding highlight");
    }

    await start();
    assert.equal(await overlays.count(), 0, "pending and running sentences do not hop");
    await finish("Eiffel Tower");
    await overlays.waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => Number(document.querySelector("[data-wfc-ui]").shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"))), 1,
      "a ready sentence is painted independently of the other requests");
    assert.ok(await page.evaluate(() => mock.requests.some(request => !request.finished)),
      "the hop starts while slower sentence requests are still pending");
    const appearance = await overlays.evaluate(node => ({
      text: node.textContent,
      pointerEvents: getComputedStyle(node).pointerEvents,
      ariaHidden: node.getAttribute("aria-hidden"),
      colors: [...node.querySelectorAll("*")].map(child => getComputedStyle(child).color),
      weights: [...node.querySelectorAll("*")].map(child => getComputedStyle(child).fontWeight),
    }));
    assert.equal(appearance.text.replace(/\s+/g, ""), (await page.locator("#target").innerText()).replace(/\s+/g, ""));
    assert.equal(appearance.pointerEvents, "none", "the moving sentence cannot intercept article links or selections");
    assert.equal(appearance.ariaHidden, "true", "the visual copy is not announced twice");
    assert.ok(appearance.colors.includes("rgb(30, 80, 160)"), "link typography is preserved");
    assert.ok(appearance.weights.includes("700"), "bold typography is preserved");
    assert.deepEqual(await page.evaluate(() => ({
      html: document.querySelector("article").innerHTML === originalHTML,
      nodes: originalNodes.every(node => node.isConnected),
      box: document.querySelector("#target").getBoundingClientRect().toJSON(),
    })), { html: true, nodes: true, box: await page.evaluate(() => originalBox) }, "the hop preserves source nodes and article layout");
    const motion = await page.evaluate(() => {
      const animation = hops[0];
      const frames = animation.effect.getKeyframes();
      const timing = animation.effect.getTiming();
      animation.currentTime = timing.duration * frames.find(frame => frame.transform === "translateY(-4px)").offset;
      const sourceRects = [...CSS.highlights.get("wfc-hopping")].map(range => range.getBoundingClientRect());
      const fragmentRects = [...animation.effect.target.querySelectorAll(".sentence-hop-fragment")].map(fragment => {
        const range = document.createRange();
        range.selectNodeContents(fragment);
        return range.getBoundingClientRect();
      });
      return { duration: timing.duration, frames: frames.map(frame => frame.transform), transform: getComputedStyle(animation.effect.target).transform,
        hiddenRanges: sourceRects.length, lines: new Set(sourceRects.map(rect => rect.top)).size,
        aligned: fragmentRects.every((rect, i) => Math.abs(rect.left - sourceRects[i].left) < .1
          && Math.abs(rect.top + 4 - sourceRects[i].top) < .1 && Math.abs(rect.width - sourceRects[i].width) < .1) };
    });
    assert.ok(motion.duration >= 250 && motion.duration <= 450, "the hop is short");
    assert.deepEqual(motion.frames.map(frame => frame.replace("(0px)", "(0)")), ["translateY(0)", "translateY(-4px)", "translateY(0)"]);
    assert.equal(motion.transform, "matrix(1, 0, 0, 1, 0, -4)");
    assert.ok(motion.hiddenRanges >= 4, "all inline source ranges hide during the visual copy");
    assert.ok(motion.lines >= 3 && motion.aligned, "multiline fragments retain their glyph positions with only the 4px upward hop");
    if (process.env.SCAN_ANIMATION_SCREENSHOT)
      await page.screenshot({ path: process.env.SCAN_ANIMATION_SCREENSHOT });
    await page.evaluate(() => hops[0].finish());
    await expectClean();

    // Complete a neighboring request without motion so the gentle scheduler can dispatch Oslo.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await finish("Helsinki");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => mock.requests.some(item => item.message.text.includes("Oslo")));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // An offscreen result and UI/deeper-analysis refreshes do not replay a completed hop.
    await finish("Oslo");
    await page.waitForFunction(() => Number(document.querySelector("[data-wfc-ui]").shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")) === 3);
    await page.locator("[data-wfc-ui] select").selectOption(await page.evaluate(() => mock.requests.find(item => item.message.text.includes("Eiffel Tower")).message.sentenceId));
    await page.getByRole("button", { name: "Open result", exact: true }).click();
    await page.waitForFunction(() => mock.deepStarts === 1);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    assert.equal(await page.evaluate(() => hops.length), 1, "results animate once, including after deep analysis and scrolling");

    // Simultaneous results retain independent overlays and source-range hiding.
    await start();
    await finish("Eiffel Tower");
    await finish("Helsinki", "REFUTED");
    await page.waitForFunction(() => hops.length === 2);
    assert.equal(await overlays.count(), 2);
    await page.evaluate(() => hops[0].finish());
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]").shadowRoot.querySelectorAll(".sentence-hop").length === 1);
    assert.ok(await page.evaluate(() => CSS.highlights.get("wfc-hopping").size > 0), "finishing one hop keeps the other sentence hidden");
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    await expectClean();

    // Every scan exit must restore the original text immediately.
    for (const action of ["resize", "stop", "clear", "invalidate"]) {
      await start();
      await finish("Eiffel Tower");
      await overlays.waitFor({ state: "attached" });
      await page.evaluate(action => {
        if (action === "resize") window.dispatchEvent(new Event("resize"));
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
    assert.equal(await page.evaluate(() => hops.length), 0, "reduced motion keeps scan results static");
    await expectClean();
    await page.evaluate(() => WikiFactPageScan.clear());
    console.log("Sentence animation passed: 4px hop, inline/multiline typography, unchanged source/layout, concurrent results, no replay, offscreen/reduced-motion skips, finish/scroll/resize/stop/clear/invalidation cleanup.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
