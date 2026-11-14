const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const local = { password: "test-password", backendUrl: "https://backend.example" }, session = {};
const storage = data => ({
  async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])); },
  async set(value) { Object.assign(data, value); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
});
const chrome = {
  runtime: { onInstalled: event(), onMessage: event() },
  contextMenus: { onClicked: event(), items: [], create(item) { this.items.push(item); } },
  sidePanel: { setPanelBehavior() {}, async open() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  storage: { local: storage(local), session: storage(session), onChanged: event() },
  tabs: { onUpdated: event(), onRemoved: event(), async sendMessage() {} },
  scripting: { async executeScript() {} },
};
const calls = [];
const delivered = [];
chrome.tabs.sendMessage = async (tabId, message, options) => { delivered.push({ tabId, message, options }); };
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

  // A sentence is delivered while the response is still open, independently of its siblings.
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const waitFor = async (condition) => {
    for (let i = 0; i < 50 && !condition(); i++) await tick();
    assert.ok(condition(), "asynchronous transport condition completed");
  };
  const encoder = new TextEncoder();
  function streamResponse() {
    let streamController;
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { streamController = controller; },
      cancel() { cancelled = true; },
    });
    return {
      response: { ...response(null), body: stream },
      write(text) { streamController.enqueue(encoder.encode(text)); },
      bytes(bytes) { streamController.enqueue(bytes); },
      close() { streamController.close(); },
      fail(error) { streamController.error(error); },
      get cancelled() { return cancelled; },
    };
  }
  const batchItems = [
    { sentenceId: "b1", text: "Helsinki is in Finland.", context: { paragraph: "Helsinki is in Finland." } },
    { sentenceId: "b2", text: "Paris is in France.", context: { paragraph: "Paris is in France." } },
  ];
  const batch = (items = batchItems, scanId = "stream", requestId = 1) => ({ type: "WFC_FAST_BATCH", scanId, requestId, items });
  const batchResult = (index, extra = {}) => ({ index, ...responderResult(), ...extra });
  await begin("stream", 3);
  let stream = streamResponse();
  responder = (_url, { signal }) => {
    signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
    return stream.response;
  };
  let streamSettled = false;
  const streaming = invoke(batch(), 3).finally(() => { streamSettled = true; });
  await waitFor(() => calls.at(-1).url.endsWith("/batch/"));
  assert.equal(JSON.parse(calls.at(-1).options.body).stream, true);
  stream.write(JSON.stringify(batchResult(1)) + "\n");
  await waitFor(() => delivered.some(item => item.message.sentenceId === "b2"));
  assert.equal(streamSettled, false, "the first result paints before the slow sibling or response end");
  assert.equal(delivered.at(-1).message.requestId, 1, "item delivery preserves retry identity");
  assert.equal(delivered.at(-1).options.frameId, 0);
  // UTF-8 and NDJSON lines can split arbitrarily, including within a multi-byte character.
  const finalBytes = encoder.encode(JSON.stringify(batchResult(0, { title: "Hämeenlinna" })));
  const umlaut = finalBytes.indexOf(0xc3);
  stream.bytes(finalBytes.slice(0, umlaut + 1));
  await tick();
  assert.equal(delivered.length, 1, "a partial JSON line is not emitted early");
  stream.bytes(finalBytes.slice(umlaut + 1));
  stream.close(); // The last valid line deliberately has no trailing newline.
  await streaming;
  assert.equal(delivered.length, 2);
  assert.equal(delivered.at(-1).message.answer.result.title, "Hämeenlinna");

  // Cached items also paint immediately while cache misses are still awaiting the network.
  const beforeCachedBatch = calls.length;
  await invoke(batch(batchItems, "stream", 2), 3);
  assert.equal(calls.length, beforeCachedBatch, "a fully cached batch needs no network request");
  assert.equal(delivered.at(-1).message.requestId, 2);
  stream = streamResponse();
  const extraItem = { sentenceId: "b3", text: "Oslo is in Norway.", context: { paragraph: "Oslo is in Norway." } };
  let mixedSettled = false;
  const mixed = invoke(batch([batchItems[0], extraItem], "stream", 3), 3).finally(() => { mixedSettled = true; });
  await waitFor(() => delivered.at(-1).message.requestId === 3);
  assert.equal(delivered.at(-1).message.sentenceId, "b1");
  assert.equal(mixedSettled, false, "cached results do not wait for uncached siblings");
  await waitFor(() => calls.length > beforeCachedBatch);
  assert.equal(JSON.parse(calls.at(-1).options.body).items.length, 1);
  stream.write(JSON.stringify(batchResult(0)) + "\n");
  await mixed;
  assert.equal(stream.cancelled, true, "all useful results release the stream without waiting for EOF");

  // Duplicate/invalid indexes cannot masquerade as a complete response or replay a hop.
  await begin("duplicates", 3);
  stream = streamResponse();
  const beforeDuplicate = delivered.length;
  const duplicate = invoke(batch(batchItems, "duplicates", 4), 3);
  const duplicateRejected = assert.rejects(duplicate, /before every sentence was answered/);
  await tick();
  stream.write([batchResult(0), batchResult(0), batchResult("1")].map(value => JSON.stringify(value)).join("\n") + "\n");
  stream.close();
  await duplicateRejected;
  assert.equal(delivered.length - beforeDuplicate, 1);

  // Cancellation keeps already painted results but stops subsequent messages and caching.
  await begin("cancel-stream", 3);
  stream = streamResponse();
  const beforeCancelled = delivered.length;
  const cancelled = invoke(batch(batchItems, "cancel-stream", 5), 3);
  const cancelledRejected = assert.rejects(cancelled, /cancelled/);
  await tick();
  stream.write(JSON.stringify(batchResult(0)) + "\n");
  await waitFor(() => delivered.length === beforeCancelled + 1);
  await invoke({ type: "WFC_SCAN_CANCEL", scanId: "cancel-stream", kind: "fast" }, 3);
  await cancelledRejected;
  assert.equal(delivered.length, beforeCancelled + 1, "cancelled streams cannot repaint later sentences");

  // In-flight work from Clear/navigation cannot become the next scan's cached result.
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
  console.log("Background passed: immediate streamed/cached items, split UTF-8/final lines, out-of-order and duplicate indexes, stream cancellation, selection compatibility, context cache, tab isolation, authenticated deep, 401/429.");
})().catch(error => { console.error(error); process.exitCode = 1; });
