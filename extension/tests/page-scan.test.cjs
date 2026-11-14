// Real DOM/Range/controller tests; Chrome runs with a mocked extension transport.
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
    await page.setContent(`<html lang="en"><head><title>Towers</title></head><body>
      <nav>Ignore navigation.</nav><article><h1>Tower facts</h1>
      ${Array.from({ length: 12 }, (_, i) => `<p id="p${i}" style="margin-top:120px">Tower ${i} was completed in <a href="https://example.org">1889</a>.</p>`).join("")}
      </article></body></html>`);
    await page.evaluate(() => {
      window.mock = { requests: [], messages: [], deepStarts: 0, polls: 0, auto: false, rateOnce: false, nextId: 0,
        uuid: () => "12345678-1234-1234-1234-" + String(++mock.nextId).padStart(12, "0") };
      window.chrome = { runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: async (message) => {
          mock.messages.push(message);
          if (message.type === "WFC_SCAN_CANCEL" && message.kind === "fast" && mock.holdCancel)
            return new Promise(resolve => { mock.releaseCancel = resolve; });
          if (message.type === "WFC_FAST") {
            if (mock.rateOnce) { mock.rateOnce = false; return { error: "Rate limited", status: 429, retryAfter: 1000 }; }
            if (mock.auto) return { result: { check_id: mock.uuid(), decision: "SUPPORTED", confidence: .9, sources: [] } };
            return new Promise(resolve => mock.requests.push({ message, resolve, finished: false }));
          }
          if (message.type === "WFC_DEEP_START") {
            mock.deepStarts++;
            return { result: { status: "pending" } };
          }
          if (message.type === "WFC_DEEP_POLL") {
            mock.polls++;
            return { result: { status: "done", explanation: "Stored Wikipedia evidence checked.", paragraphs: [], errors: [] } };
          }
          return {};
        },
      } };
    });
    for (const file of ["vendor/Readability.js", "article.js", "page-ui.js", "page-scan.js"])
      await page.addScriptTag({ path: path.resolve(__dirname, "..", file) });

    // Start while reading the middle: these visible targets must beat earlier offscreen ones.
    await page.locator("#p7").scrollIntoViewIfNeeded();
    await page.evaluate(() => WikiFactPageScan.start());
    await page.waitForFunction(() => mock.requests.length === 3);
    const first = await page.evaluate(() => mock.requests.map(r => r.message.text));
    assert.ok(first.some(text => /Tower [678]/.test(text)), "Visible targets get priority");
    assert.equal(await page.evaluate(() => mock.deepStarts), 0);
    const count = await page.locator("[data-wfc-ui] select option").count();
    assert.ok(count >= 12, "Full loaded article is queued");

    async function finishBatch() {
      await page.evaluate(() => {
        for (const [i, request] of mock.requests.entries()) {
          if (request.finished) continue;
          request.finished = true;
          request.resolve({ result: { check_id: mock.uuid(), decision: ["SUPPORTED", "REFUTED", "NOT ENOUGH INFO"][i % 3], confidence: .82,
            sources: ["https://en.wikipedia.org/wiki/Tower"] } });
        }
      });
      await page.waitForTimeout(30);
    }
    for (let i = 0; i < count; i++) {
      await finishBatch();
      const active = await page.evaluate(() => mock.requests.filter(r => !r.finished).length);
      assert.ok(active <= 3, "Fast concurrency stays bounded");
      if (await page.locator('[data-wfc-ui] progress').getAttribute("value") === String(count)) break;
    }
    assert.equal(await page.evaluate(() => mock.requests.length), count);
    assert.equal(await page.evaluate(() => mock.deepStarts), 0, "Page scans never auto-start explanations");
    assert.equal(await page.evaluate(() => mock.requests.every(r => r.message.context.paragraph.includes(r.message.text))), true);
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-supported").size > 0 && CSS.highlights.get("wfc-refuted").size > 0 && CSS.highlights.get("wfc-uncertain").size > 0), true);

    // Hover and actual text clicks use original Range locations, including links.
    await page.locator("#p0").scrollIntoViewIfNeeded();
    const box = await page.locator("#p0").boundingBox();
    await page.mouse.move(box.x + 20, box.y + 8);
    await page.locator('[data-wfc-ui] .popover').waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => mock.deepStarts), 0, "Hover is fast-only");
    await page.mouse.click(box.x + 20, box.y + 8);
    await page.waitForFunction(() => mock.deepStarts === 1);
    await page.mouse.click(box.x + 20, box.y + 8);
    assert.equal(await page.evaluate(() => mock.deepStarts), 1, "Repeated clicks start once");
    await page.waitForFunction(() => mock.polls === 1);
    await page.locator('[data-wfc-ui] .popover').getByText("Stored Wikipedia evidence checked.").waitFor();
    await page.keyboard.press("Escape");

    // Green, red and completed gray all allow explicit deep work through keyboard controls.
    for (const label of ["Supported", "Refuted", "Uncertain"]) {
      const option = page.locator('[data-wfc-ui] option').filter({ hasText: label }).first();
      await page.locator('[data-wfc-ui] select').selectOption(await option.getAttribute("value"));
      await page.getByRole("button", { name: "Open result", exact: true }).click();
      await page.keyboard.press("Escape");
    }
    assert.ok(await page.evaluate(() => mock.deepStarts) >= 3);

    const before = await page.evaluate(() => mock.requests.length);
    await page.evaluate(() => document.querySelector("article").insertAdjacentHTML("beforeend", '<p id="new">Newly loaded claim.</p>'));
    await page.getByText("Article changed. Select Rescan to check the current content.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => mock.requests.length), before, "New content requires explicit Rescan");
    await page.evaluate(() => { mock.auto = true; return WikiFactPageScan.start(); });
    await page.waitForFunction(() => [...document.querySelector('div[data-wfc-ui]').shadowRoot.querySelectorAll('option')].some(o => o.textContent.includes('Newly loaded claim.')));

    // Stop and Clear ignore responses from earlier scans, rather than repainting stale ranges.
    await page.evaluate(() => { mock.auto = false; return WikiFactPageScan.start(); });
    await page.waitForFunction((n) => mock.requests.length >= n + 3, before);
    await page.evaluate(() => WikiFactPageScan.stop());
    await finishBatch();
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-supported").size), 0);
    await page.evaluate(() => {
      mock.holdCancel = true;
      WikiFactPageScan.stop();
      mock.retryPromise = WikiFactPageScan.retry();
    });
    const stoppedRequests = await page.evaluate(() => mock.requests.length);
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => mock.requests.length), stoppedRequests, "Retry waits for Stop cancellation acknowledgment");
    await page.evaluate(() => { mock.holdCancel = false; mock.releaseCancel({}); return mock.retryPromise; });
    await page.waitForFunction(n => mock.requests.length > n, stoppedRequests);
    await page.evaluate(() => WikiFactPageScan.clear());
    await finishBatch();
    assert.equal(await page.locator("[data-wfc-ui]").count(), 0);
    assert.equal(await page.evaluate(() => CSS.highlights.has("wfc-supported")), false);

    // A mutated source invalidates pending results; appending blocks above never did.
    await page.evaluate(() => WikiFactPageScan.start());
    await page.waitForFunction((n) => mock.requests.length > n, before + 3);
    await page.evaluate(() => { document.querySelector("#p0").firstChild.data = "Changed original sentence. "; });
    await page.getByText("Article text changed. Choose Rescan to check the current content.", { exact: true }).waitFor();
    await finishBatch();
    assert.equal(await page.evaluate(() => CSS.highlights.get("wfc-supported")?.size || 0), 0);

    // Failed checks can be explicitly retried; a 429 pauses and retries the bounded queue.
    await page.evaluate(() => WikiFactPageScan.clear());
    await page.evaluate(() => { mock.auto = false; mock.rateOnce = true; return WikiFactPageScan.start(); });
    await page.waitForFunction(() => mock.messages.some(m => m.type === "WFC_FAST"));
    const fastAtRate = await page.evaluate(() => mock.messages.filter(m => m.type === "WFC_FAST").length);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => mock.messages.filter(m => m.type === "WFC_FAST").length), fastAtRate, "Rate limit imposes shared cooldown");
    await page.waitForTimeout(1050);
    await page.evaluate(() => {
      for (const request of mock.requests) if (!request.finished) { request.finished = true; request.resolve({ error: "Test backend failure", status: 502 }); }
    });
    await page.getByRole("button", { name: "Retry failed" }).waitFor({ state: "visible" });
    await page.evaluate(() => {
      mock.auto = true;
      for (const request of mock.requests) if (!request.finished) {
        request.finished = true;
        request.resolve({ result: { check_id: mock.uuid(), decision: "SUPPORTED", confidence: .9, sources: [] } });
      }
      WikiFactPageScan.retry();
    });
    await page.waitForFunction(() => {
      const shadow = document.querySelector('div[data-wfc-ui]').shadowRoot;
      return [...shadow.querySelectorAll('option')].every(o => o.textContent.includes('Supported'));
    });
    await page.evaluate(() => WikiFactPageScan.clear());
    // Strict article CSP must not suppress the guide or the Custom Highlight stylesheet.
    await page.setContent('<html lang="en"><head><meta http-equiv="Content-Security-Policy" content="style-src \'none\'"><title>CSP article</title></head><body><article><h1>Paris landmarks</h1><p>The Eiffel Tower stands in Paris. It was completed in 1889.</p></article></body></html>');
    await page.evaluate(() => WikiFactPageScan.start());
    await page.waitForFunction(() => CSS.highlights.get("wfc-supported")?.size > 0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.some(sheet =>
      [...sheet.cssRules].some(rule => rule.selectorText === "::highlight(wfc-supported)"))), true);
    assert.equal(await page.locator('[data-wfc-ui] .guide').evaluate(node => getComputedStyle(node).borderTopWidth), "2px");
    await page.getByRole("button", { name: "Open result", exact: true }).click();
    if (process.env.WFC_SCREENSHOT) await page.screenshot({ path: process.env.WFC_SCREENSHOT });
    await page.evaluate(() => WikiFactPageScan.clear());
    console.log("Page scans passed: bounded/visible queue, all loaded text, progressive verdicts, hover/click deep, explicit rescan, stale cancellation, retry/backoff.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
