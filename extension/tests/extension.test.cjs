// Real unpacked-extension regression: no Chrome API or content-script transport mocks.
// Requires Chrome for Testing/Chromium; branded Chrome may reject extension loading flags.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

(async () => {
  const extension = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-extension-test-"));
  const requests = [], timers = new Set();
  let context, releaseFirst;
  let active = 0, peakActive = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const item = JSON.parse(text);
      const index = Number(item.text?.match(/^Tower (\d+) /)?.[1]);
      requests.push({ path: request.url, index, fastOnly: item.fast_only });
      active++;
      peakActive = Math.max(peakActive, active);
      response.once("close", () => active--);
      if (request.url !== "/api/factcheck/" || item.fast_only !== true || !Number.isInteger(index)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Expected one fast-only sentence JSON request." }));
        return;
      }
      const answer = () => {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({
          sentence_id: item.sentence_id, decision: "SUPPORTED", confidence: .9, sources: [], explanation_id: null,
          check_id: "12345678-1234-1234-1234-" + String(index).padStart(12, "0"),
        }));
      };
      if (index === 0) releaseFirst = answer;
      else {
        const timer = setTimeout(() => { timers.delete(timer); answer(); }, 20);
        timers.add(timer);
      }
      return;
    }
    if (request.url !== "/story") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<html lang="en"><head><title>Tower facts</title></head><body><article>
      ${Array.from({ length: 38 }, (_, index) => `<p>Tower ${index} was completed in 1889 and remains a famous landmark in the capital of France.</p>`).join("")}
      </article></body></html>`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + server.address().port;
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true,
      args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    await worker.evaluate(async backendUrl => {
      await chrome.storage.local.set({ password: "test-password", backendUrl });
    }, base);
    const page = await context.newPage();
    await page.goto(base + "/story");
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      await startPageScan(tab.id);
    }, base + "/story");

    // Every other answer must be usable while the first request is still deliberately blocked.
    await page.waitForFunction(() => {
      const shadow = document.querySelector("[data-wfc-ui]")?.shadowRoot;
      const options = [...shadow?.querySelectorAll("option") || []];
      return Number(shadow?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")) === 37 &&
        options.filter(option => option.textContent.includes("Supported")).length === 37 &&
        options.some(option => option.textContent.includes("Checking") && option.textContent.includes("Tower 0 "));
    }, null, { timeout: 15000 });
    assert.equal(requests.length, 38, "a slow first sentence cannot prevent the queue from refilling");
    assert.ok(peakActive >= 2 && peakActive <= 12, "real network requests run concurrently within the scan limit");
    assert.ok(requests.every(item => item.path === "/api/factcheck/" && item.fastOnly),
      "all sentences use independent fast-only JSON requests");
    assert.equal(new Set(requests.map(item => item.index)).size, 38, "every sentence is checked exactly once");
    assert.equal(typeof releaseFirst, "function");
    releaseFirst();
    releaseFirst = null;
    await page.waitForFunction(() => document.querySelector("[data-wfc-ui]")?.shadowRoot
      .querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "38", null, { timeout: 15000 });
    const final = await page.evaluate(() => {
      const shadow = document.querySelector("[data-wfc-ui]").shadowRoot;
      const options = [...shadow.querySelectorAll("option")];
      return {
        supported: options.filter(option => option.textContent.includes("Supported")).length,
        failed: options.filter(option => option.textContent.includes("Check failed")).length,
        width: shadow.querySelector(".bar .supported").style.width,
      };
    });
    assert.deepEqual(final, { supported: 38, failed: 0, width: "100%" });
    console.log("Extension integration passed: real Chrome messaging, 38 independent JSON checks, all 37 later results before the blocked first, bounded concurrency, zero failures, colored progress bar.");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    releaseFirst?.();
    try { await context?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
