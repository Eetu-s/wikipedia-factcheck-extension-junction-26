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
let responder = () => ({ decision: "SUPPORTED", confidence: .9, sources: [], explanation_id: null,
  check_id: "12345678-1234-1234-1234-123456789abc" });
const response = (data, status = 200, retryAfter = "1") => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => retryAfter }, async json() { return data; } });
const context = vm.createContext({
  chrome, URL, setTimeout, clearTimeout, AbortController,
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
  console.log("Background passed: selection compatibility, fast-only/context cache, tab isolation, authenticated deep, cancellation, 401/429.");
})().catch(error => { console.error(error); process.exitCode = 1; });
