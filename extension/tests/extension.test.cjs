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
  const successful = new Set();
  let context, releaseFirst;
  let active = 0, peakActive = 0, gatewayFailures = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const item = JSON.parse(text);
      const index = Number(item.text?.match(/^Tower (\d+) /)?.[1]);
      const call = { path: request.url, index, fastOnly: item.fast_only, status: null };
      requests.push(call);
      active++;
      peakActive = Math.max(peakActive, active);
      response.once("close", () => active--);
      if (request.url !== "/api/factcheck/" || item.fast_only !== true || !Number.isInteger(index)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Expected one fast-only sentence JSON request." }));
        return;
      }
      // A gateway commonly answers with HTML, rather than the API's structured JSON.
      // These two failures must be retried without draining the article into failed states.
      if (gatewayFailures < 2) {
        gatewayFailures++;
        call.status = 502;
        response.writeHead(502, { "Content-Type": "text/html" });
        response.end("<!doctype html><title>502 Bad Gateway</title><h1>Bad Gateway</h1>");
        return;
      }
      const answer = () => {
        call.status = 200;
        successful.add(index);
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

    // After recovering from the gateway errors, every other answer must be usable
    // while the first sentence's retried request is still deliberately blocked.
    await page.waitForFunction(() => {
      const shadow = document.querySelector("[data-wfc-ui]")?.shadowRoot;
      const options = [...shadow?.querySelectorAll("option") || []];
      return Number(shadow?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")) === 37 &&
        options.filter(option => option.textContent.includes("Supported")).length === 37 &&
        options.some(option => option.textContent.includes("Checking") && option.textContent.includes("Tower 0 "));
    }, null, { timeout: 15000 });
    assert.equal(gatewayFailures, 2, "the real extension recovers from both HTML gateway errors");
    assert.equal(requests.length, 40, "the failed checks retry without blocking the rest of the article");
    assert.equal(successful.size, 37, "all later sentences finish before the held first retry");
    assert.equal(successful.has(0), false);
    assert.ok(peakActive >= 2 && peakActive <= 4, "real requests stay within the adaptive concurrency limit");
    assert.ok(requests.every(item => item.path === "/api/factcheck/" && item.fastOnly),
      "all sentences use independent fast-only JSON requests");
    assert.equal(new Set(requests.map(item => item.index)).size, 38, "retries preserve every article sentence");
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
    assert.equal(requests.filter(item => item.status === 200).length, 38);
    console.log("Extension integration passed: real Chrome messaging, automatic recovery from two HTML 502 errors, all 37 later results before the blocked first retry, bounded concurrency, 38 supported / zero failed, colored progress bar.");
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
