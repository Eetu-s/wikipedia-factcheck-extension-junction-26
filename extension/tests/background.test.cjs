const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const local = { password: "test-password", backendUrl: "https://backend.example" }, session = {};
let sessionReads = 0;
const storage = data => ({
  async get(keys) {
    if (data === session) sessionReads++;
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]));
  },
  async set(value) { Object.assign(data, value); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
});
const deliveries = [];
const chrome = {
  runtime: { onInstalled: event(), onMessage: event() },
  contextMenus: { onClicked: event(), items: [], create(item) { this.items.push(item); } },
  sidePanel: { setPanelBehavior() {}, async open() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  storage: { local: storage(local), session: storage(session), onChanged: event() },
  tabs: { onUpdated: event(), onRemoved: event(), async sendMessage(tabId, message) { deliveries.push({ tabId, message }); } },
  scripting: { async executeScript() {} },
};
const calls = [];
let responder = () => ({ decision: "SUPPORTED", confidence: .9, sources: [], explanation_id: null,
  check_id: "12345678-1234-1234-1234-123456789abc" });
const response = (data, status = 200, retryAfter = "1") => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => retryAfter }, async json() { return data; } });
const context = vm.createContext({
  chrome, URL, setTimeout, clearTimeout, AbortController, TextDecoder,
  fetch: async (url, options) => { calls.push({ url, options }); return responder(url, options); },
});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8"), context);
const invoke = (message, tab = 1) => context.pageMessage(message, { tab: { id: tab }, frameId: 0, url: "https://article.example/story" });
const begin = (id = "scan", tab = 1) => invoke({ type: "WFC_SCAN_BEGIN", scanId: id }, tab);
const fast = (context = { paragraph: "The tower is in Paris. It opened in 1889." }, scanId = "scan") => ({
  type: "WFC_FAST", scanId, sentenceId: "s1", text: "It opened in 1889.", context,
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// A reader whose chunks and completion are controlled independently of its fetch response.
function streamedResponse() {
  const chunks = [], waiters = [];
  const push = chunk => waiters.length ? waiters.shift().resolve(chunk) : chunks.push(chunk);
  return {
    response: { ...response({}), body: { getReader: () => ({
      read: () => chunks.length ? Promise.resolve(chunks.shift()) :
        new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    }) } },
    push(value) { push({ done: false, value: typeof value === "string" ? new TextEncoder().encode(value) : value }); },
    end() { push({ done: true }); },
    fail(error) { for (const waiter of waiters.splice(0)) waiter.reject(error); },
  };
}

(async () => {
  for (const listener of chrome.runtime.onInstalled.listeners) listener();
  assert.deepEqual(chrome.contextMenus.items.map(i => i.title), ["Fact-check selection", "Fact-check this page"]);
  responder = () => response(responderResult());
  function responderResult() { return { decision: "SUPPORTED", confidence: .9, sources: [], explanation_id: null,
    check_id: "12345678-1234-1234-1234-123456789abc" }; }
  await begin();
  const first = await invoke(fast());
  assert.equal(first.result.decision, "SUPPORTED");
  assert.equal(calls.at(-1).url, "https://backend.example/api/factcheck/", "Page scans use the password endpoint");
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.fast_only, true);
  assert.equal(body.password, "test-password");
  assert.equal(body.sentence_id, "s1");
  assert.equal(body.context.paragraph, fast().context.paragraph);
  const n = calls.length;
  await invoke(fast());
  assert.equal(calls.length, n, "Identical sentence and context reuse stored fast results");
  await invoke(fast({ paragraph: "A different subject. It opened in 1889." }));
  assert.equal(calls.length, n + 1, "Context changes cannot reuse a sentence-only cache");
  await begin("other", 2);
  await invoke(fast(undefined, "other"), 2);
  assert.equal(calls.length, n + 2, "Tabs keep separate state");
  assert.equal((await invoke(fast(undefined, "stale"))).stale, true);

  responder = () => response({ status: "pending" });
  await invoke({ type: "WFC_DEEP_START", scanId: "scan", sentenceId: "s1", checkId: first.result.check_id });
  assert.ok(calls.at(-1).url.endsWith("/analyze/"));
  await invoke({ type: "WFC_DEEP_POLL", scanId: "scan", sentenceId: "s1", checkId: first.result.check_id });
  assert.equal(calls.at(-1).options.method, "GET");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer test-password");
  assert.equal(calls.at(-1).options.body, undefined, "Poll credentials never enter a URL");

  // Selection requests keep their existing endpoint/body and automatic legacy response.
  responder = () => response({ decision: "REFUTED", confidence: .8, sources: [], explanation_id: null });
  await context.checkText("A selection remains available.");
  assert.equal(session.job.status, "done");
  assert.equal(calls.at(-1).url, "https://backend.example/api/factcheck/", "Selections use the password endpoint");
  assert.equal(JSON.parse(calls.at(-1).options.body).password, "test-password");
  assert.equal(JSON.parse(calls.at(-1).options.body).fast_only, undefined);

  // Streamed batches deliver completed sentences before the connection closes. A chunk
  // containing several answers needs one storage read, rather than one per sentence.
  await begin("batch");
  const items = Array.from({ length: 4 }, (_, index) => ({
    sentenceId: `batch-${index}`, text: `Batch claim ${index}.`, context: { language: "sv" },
  }));
  const batchMessage = { type: "WFC_FAST_BATCH", scanId: "batch", batchId: 42, items };
  const line = (index, extra = {}) => JSON.stringify({ index, ...responderResult(), ...extra });
  let stream = streamedResponse();
  responder = () => stream.response;
  deliveries.length = 0;
  let batchFinished = false;
  const batch = invoke(batchMessage).then(value => { batchFinished = true; return value; });
  await tick();
  assert.equal(calls.at(-1).url, "https://backend.example/api/factcheck/batch/");
  const batchBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(batchBody.password, "test-password");
  assert.equal(batchBody.stream, true);
  assert.equal(batchBody.items[0].sentence_id, items[0].sentenceId);
  const beforeChunk = sessionReads;
  stream.push([line(0), line(1), line(0), line("2"), "null", ""].join("\n"));
  await tick();
  assert.equal(sessionReads - beforeChunk, 1, "coalesced answers validate the scan once per chunk");
  assert.deepEqual(deliveries.map(item => item.message.sentenceId), ["batch-0", "batch-1"],
    "duplicate and invalid indices cannot deliver a sentence twice");
  assert.equal(batchFinished, false, "fast answers reach the page while the stream is open");
  // Network boundaries may split a UTF-8 character and the final line may omit its newline.
  const bytes = new TextEncoder().encode(line(2, { sources: ["https://example.test/Åbo"] }) + "\n" + line(3));
  const split = bytes.indexOf(0xc3) + 1;
  stream.push(bytes.slice(0, split));
  await tick();
  assert.equal(deliveries.length, 2);
  stream.push(bytes.slice(split));
  stream.end();
  assert.deepEqual(Object.keys(await batch), []);
  assert.equal(deliveries.length, 4);
  assert.equal(deliveries[2].message.answer.result.sources[0], "https://example.test/Åbo");
  assert.ok(deliveries.every(item => item.tabId === 1 && item.message.scanId === "batch" && item.message.batchId === 42),
    "streamed answers echo the request's batch identity");
  const beforeCache = calls.length;
  await invoke(batchMessage);
  assert.equal(calls.length, beforeCache, "completed streamed results are cached within their scan");
  assert.ok(deliveries.every(item => item.message.batchId === 42), "cached answers retain the requesting batch identity");

  // A token replacement between chunks rejects the remainder without caching it for the
  // replacement scan. This also covers service-worker token changes without a local abort.
  await begin("old-stream");
  stream = streamedResponse();
  responder = () => stream.response;
  deliveries.length = 0;
  const staleBatch = invoke({ ...batchMessage, scanId: "old-stream" });
  await tick();
  stream.push(line(0) + "\n");
  await tick();
  assert.equal(deliveries.length, 1);
  session["pageScan:1"] = { id: "replacement", url: "https://article.example/story" };
  stream.push([line(1), line(2), line(3), ""].join("\n"));
  assert.equal((await staleBatch).stale, true);
  assert.equal(deliveries.length, 1, "a stale chunk is never sent to the page");
  const afterStale = calls.length;
  stream = streamedResponse();
  const replacementBatch = invoke({ ...batchMessage, scanId: "replacement", items: [items[1]] });
  await tick();
  assert.equal(calls.length, afterStale + 1, "a discarded stale answer cannot populate the replacement cache");
  stream.push(line(0));
  stream.end();
  await replacementBatch;

  // Duplicate indices cannot hide a missing answer and make a batch look complete.
  await begin("missing");
  stream = streamedResponse();
  const missing = invoke({ ...batchMessage, scanId: "missing", items: items.slice(0, 2) });
  const missingRejected = assert.rejects(missing, /streamed page checks/);
  await tick();
  stream.push(line(0) + "\n" + line(0) + "\n");
  stream.end();
  await missingRejected;

  // Clear aborts an open stream; its unresolved work never becomes a later cached result.
  await begin("cancel-stream");
  stream = streamedResponse();
  responder = (_url, { signal }) => {
    signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
    return stream.response;
  };
  const cancelled = invoke({ ...batchMessage, scanId: "cancel-stream" });
  const cancelledRejected = assert.rejects(cancelled, /cancelled/);
  await tick();
  await invoke({ type: "WFC_SCAN_CANCEL", scanId: "cancel-stream" });
  await cancelledRejected;
  assert.equal((await invoke({ ...batchMessage, scanId: "cancel-stream" })).stale, true);

  // In-flight work from Clear/navigation cannot become the next scan's cached result.
  await begin();
  let finish;
  responder = (_url, { signal }) => new Promise((resolve, reject) => {
    finish = () => resolve(response(responderResult()));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const pending = invoke(fast({ paragraph: "Uncached" }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const rejected = assert.rejects(pending, /cancelled/);
  await invoke({ type: "WFC_SCAN_CANCEL", scanId: "scan" });
  finish();
  await rejected;
  assert.equal((await invoke(fast())).stale, true);

  // Auth/rate-limit failures remain structured so the page queue can stop/back off.
  await begin("fresh");
  responder = () => response({ error: "Too many requests" }, 429, "3");
  let error;
  try { await invoke(fast({ paragraph: "rate" }, "fresh")); } catch (caught) { error = caught; }
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, 3000);
  responder = () => response({ error: "Invalid password" }, 401);
  try { await invoke(fast({ paragraph: "auth" }, "fresh")); } catch (caught) { error = caught; }
  assert.equal(error.status, 401);
  assert.equal(local.password, undefined);
  // An old request cannot erase a newer login after returning a delayed 401.
  local.password = "old-password";
  let unauthorized;
  responder = () => new Promise(resolve => { unauthorized = () => resolve(response({}, 401)); });
  const oldLoginRequest = invoke(fast({ paragraph: "old login" }, "fresh"));
  const oldRejected = assert.rejects(oldLoginRequest, /Wrong password/);
  await new Promise(resolve => setTimeout(resolve, 0));
  local.password = "new-password";
  unauthorized();
  await oldRejected;
  assert.equal(local.password, "new-password");
  await chrome.tabs.onRemoved.listeners[0](2);
  assert.equal(session["pageScan:2"], undefined);
  console.log("Background passed: streamed batches/chunk reads, partial UTF-8, deduplication, cache/stale isolation, cancellation, selection compatibility, authenticated deep, 401/429.");
})().catch(error => { console.error(error); process.exitCode = 1; });
