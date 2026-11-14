// Background service worker: adds the right-click menu item and calls the backend.
//
// Flow: user selects text -> right-click "Fact-check selection" -> side panel opens ->
// we POST the text to the backend -> the result is saved to chrome.storage.session ->
// the side panel (sidepanel.js) sees the change and shows it.
// If the result has an explanation_id, the explanation is fetched afterwards and added to the
// same job (job.explanation), so the verdict shows first and the explanation follows.

const DEFAULT_BACKEND_URL = "https://klausde.tech";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "fact-check",
    title: "Fact-check selection",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "fact-check-page",
    title: "Fact-check this page",
    contexts: ["page", "selection", "link", "image"],
  });
  // Clicking the toolbar icon opens the side panel (where the settings are).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "fact-check-page") {
    const pageUrl = info.pageUrl || tab.url || "";
    if (/^(chrome|chrome-extension|edge|about|devtools):/.test(pageUrl) || pageUrl.startsWith("https://chromewebstore.google.com/")) {
      // Chrome requires open() in the synchronous context-menu user gesture.
      chrome.sidePanel.open({ tabId: tab.id });
      chrome.storage.session.set({ job: { status: "error", text: "Page scan",
        error: "Chrome protects this page from extension scripts. Open an article website to scan it." } });
      return;
    }
    startPageScan(tab.id).catch(async (error) => {
      await chrome.storage.session.set({ job: { status: "error", text: "Page scan", error: error.message } });
      await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b5362d" });
      await chrome.action.setTitle({ tabId: tab.id, title: "Page scan failed. Open the side panel: " + error.message });
    });
    return;
  }
  if (info.menuItemId !== "fact-check") return;
  // Must be called right away (inside the click), before any await.
  chrome.sidePanel.open({ tabId: tab.id });
  checkText(info.selectionText);
});

async function checkText(text) {
  await chrome.storage.session.set({ job: { status: "loading", text } });
  let result;
  try {
    result = await callBackend(text);
  } catch (e) {
    await chrome.storage.session.set({ job: { status: "error", text, error: e.message } });
    return;
  }
  const id = result.explanation_id;
  // startedAt lets the side panel give up on an explanation that never arrives.
  const explanation = id ? { status: "loading", startedAt: Date.now() } : undefined;
  await chrome.storage.session.set({ job: { status: "done", text, result, explanation } });
  if (id) await updateExplanation(id, await fetchExplanation(id));
}

// The backend URL, entered by the user in the side panel's login form.
async function backendBase() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  const base = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, "");
  // Never send the password unencrypted over the internet. Plain http is only OK for local dev.
  const { protocol, hostname } = new URL(base);
  if (protocol !== "https:" && !(protocol === "http:" && ["localhost", "127.0.0.1"].includes(hostname))) {
    throw new Error("The backend URL must start with https:// (http is only allowed for localhost).");
  }
  return base;
}

async function callBackend(text) {
  return authenticatedRequest("/api/factcheck/", { text });
}

// With raw = true, a successful response is returned unread (for streaming); errors are handled
// the same way either way.
async function authenticatedRequest(path, body, signal, method = "POST", raw = false) {
  const { password } = await chrome.storage.local.get("password");
  if (!password) throw new Error("Not logged in.");
  const url = (await backendBase()) + path;

  let response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: { "Content-Type": "application/json", ...(method === "GET" ? { Authorization: "Bearer " + password } : {}) },
      // The password travels in the body. Use an https:// backend URL so it is encrypted in transit.
      ...(method === "GET" ? {} : { body: JSON.stringify({ ...body, password }) }),
    });
  } catch (e) {
    if (signal?.aborted) throw new Error("Request cancelled or timed out.");
    throw new Error("Can't reach the backend at " + url);
  }

  if (raw && response.ok) return response;
  const data = await response.json().catch(() => ({}));
  if (signal?.aborted) throw new Error("Request cancelled or timed out.");
  if (response.status === 401) {
    // Forget the bad password; the side panel then shows the login form again.
    const current = await chrome.storage.local.get("password");
    if (current.password === password && !signal?.aborted) await chrome.storage.local.remove("password");
    const error = new Error("Wrong password. Please log in again from the extension's side panel.");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || "Backend error (HTTP " + response.status + ")");
    error.status = response.status;
    const retry = response.headers.get("Retry-After");
    error.retryAfter = Math.max(1000, Math.min(300000, Number(retry) * 1000 || Date.parse(retry) - Date.now() || 2000));
    throw error;
  }
  return data;
}

// Page jobs are isolated from the selection panel and from other tabs. A durable scan token
// survives service-worker suspension; only request controllers and the bounded cache are transient.
const pageRequests = new Map();
const pageCache = new Map();

// Forget the cached fast results of one tab (cache keys are JSON arrays with the tab id second).
function clearPageCache(tabId) {
  for (const key of pageCache.keys()) {
    if (JSON.parse(key)[1] === tabId) pageCache.delete(key);
  }
}
const SCAN_KEY = (tabId) => "pageScan:" + tabId;

async function startPageScan(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["vendor/Readability.js", "article.js", "page-ui.js", "page-scan.js"],
  });
  await chrome.tabs.sendMessage(tabId, { type: "WFC_PAGE_START" });
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: "Wikipedia Fact Check" });
}

function abortPageRequests(tabId, scanId, kind) {
  for (const [key, entry] of pageRequests) {
    if (entry.tabId === tabId && (!scanId || entry.scanId === scanId) && (!kind || entry.kind === kind)) {
      entry.controller.abort();
      pageRequests.delete(key);
    }
  }
}

async function pageMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.frameId !== 0) throw new Error("Page scans require the main frame.");
  const scanKey = SCAN_KEY(tabId);
  if (message.type === "WFC_SCAN_BEGIN") {
    abortPageRequests(tabId);
    // A new scan or Rescan asks the backend again instead of reusing cached results.
    clearPageCache(tabId);
    await chrome.storage.session.set({ [scanKey]: { id: message.scanId, url: sender.url } });
    return {};
  }
  const saved = (await chrome.storage.session.get(scanKey))[scanKey];
  if (!saved || saved.id !== message.scanId || saved.url !== sender.url) return { stale: true };
  if (message.type === "WFC_SCAN_CANCEL") {
    abortPageRequests(tabId, message.scanId, message.kind);
    if (!message.kind) {
      // Clear: forget this tab's scan and its cached results.
      clearPageCache(tabId);
      await chrome.storage.session.remove(scanKey);
    }
    return {};
  }
  const { backendUrl, password } = await chrome.storage.local.get(["backendUrl", "password"]);
  if (!password) return { error: "Log in using the extension's toolbar side panel, then choose Rescan.", status: 401 };
  if (message.type === "WFC_FAST_BATCH") return pageBatch(message, sender, tabId, scanKey, backendUrl);
  const isFast = message.type === "WFC_FAST";
  if (!isFast && !["WFC_DEEP_START", "WFC_DEEP_POLL"].includes(message.type)) throw new Error("Unknown page request.");
  const key = [tabId, message.scanId, message.sentenceId, isFast ? "fast" : "deep"].join(":");
  // Include context, exact original wording, sentence identity, page and backend in the cache key.
  const cacheKey = JSON.stringify([backendUrl, tabId, sender.url, message.sentenceId, message.text, message.context]);
  const cached = pageCache.get(cacheKey);
  if (isFast && cached && Date.now() - cached.at < 15 * 60 * 1000) return { result: cached.result };
  const controller = new AbortController();
  const entry = { controller, tabId, scanId: message.scanId, kind: isFast ? "fast" : "deep" };
  pageRequests.set(key, entry);
  const timer = setTimeout(() => controller.abort(), 28000);
  try {
    let result;
    if (isFast) {
      result = await authenticatedRequest("/api/factcheck/", {
        text: message.text, sentence_id: message.sentenceId, context: message.context, fast_only: true,
      }, controller.signal);
    } else {
      if (typeof message.checkId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.checkId)) throw new Error("Invalid check ID.");
      const path = "/api/factcheck/check/" + encodeURIComponent(message.checkId) + "/";
      result = await authenticatedRequest(path + (message.type === "WFC_DEEP_START" ? "analyze/" : ""), {},
        controller.signal, message.type === "WFC_DEEP_POLL" ? "GET" : "POST");
    }
    const current = (await chrome.storage.session.get(scanKey))[scanKey];
    if (controller.signal.aborted || current?.id !== message.scanId || current?.url !== sender.url) return { stale: true };
    if (isFast) {
      // Refuse a legacy server response that may already have launched unsolicited analysis.
      if (!result.check_id || result.explanation_id) throw new Error("Update the backend to support fast-only page checks.");
      pageCache.set(cacheKey, { at: Date.now(), result });
      if (pageCache.size > 500) pageCache.delete(pageCache.keys().next().value);
    }
    return { result };
  } finally {
    clearTimeout(timer);
    if (pageRequests.get(key) === entry) pageRequests.delete(key);
  }
}

// Fast checks for several sentences in one streamed backend request (one password hash, one
// embedding call and grouped database writes on the server). Each sentence's answer goes to the
// page as soon as it arrives, as { type: "WFC_FAST_ITEM", scanId, sentenceId, answer }, where
// answer is { result } or { error, status, retryAfter }. The reply itself comes after every item
// message: {} when the stream is complete, { stale: true }, or a thrown error for the whole request.
// The page scan applies the reply to any sentence of the batch it hasn't had an answer for.
let batchCounter = 0;
// Abort a batch when the backend sends nothing for this long (Chrome may stop a background
// script whose fetch has no response for about 30 s).
const BATCH_IDLE_TIMEOUT = 28000;

async function pageBatch(message, sender, tabId, scanKey, backendUrl) {
  if (!Array.isArray(message.items) || !message.items.length) throw new Error("Empty page batch.");
  const cacheKeyOf = (item) =>
    JSON.stringify([backendUrl, tabId, sender.url, item.sentenceId, item.text, item.context]);
  const deliveries = [];
  const deliver = (item, answer) => deliveries.push(chrome.tabs.sendMessage(tabId, {
    type: "WFC_FAST_ITEM", scanId: message.scanId, sentenceId: item.sentenceId, answer,
  }, { frameId: 0 }).catch(() => {}));

  const misses = [];
  for (const item of message.items) {
    const cached = pageCache.get(cacheKeyOf(item));
    if (cached && Date.now() - cached.at < 15 * 60 * 1000) deliver(item, { result: cached.result });
    else misses.push(item);
  }
  if (!misses.length) {
    await Promise.all(deliveries);
    return {};
  }

  const key = [tabId, message.scanId, "batch", ++batchCounter, "fast"].join(":");
  const controller = new AbortController();
  const entry = { controller, tabId, scanId: message.scanId, kind: "fast" };
  pageRequests.set(key, entry);
  let timer;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), BATCH_IDLE_TIMEOUT);
  };
  const stillCurrent = async () => {
    const current = (await chrome.storage.session.get(scanKey))[scanKey];
    return !controller.signal.aborted && current?.id === message.scanId && current?.url === sender.url;
  };
  resetTimer();
  try {
    const response = await authenticatedRequest("/api/factcheck/batch/", {
      items: misses.map((item) => ({ text: item.text, sentence_id: item.sentenceId, context: item.context })),
      stream: true,
    }, controller.signal, "POST", true);

    // NDJSON: one {"index", ...answer} line per sentence, in the order the decisions finish.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let received = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new Error(controller.signal.aborted ? "Request cancelled or timed out." : "The connection to the backend was lost.");
      }
      if (chunk.done) break;
      resetTimer();
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!(await stillCurrent())) {
          controller.abort();
          return { stale: true };
        }
        let answer;
        try {
          answer = JSON.parse(line);
        } catch (e) {
          continue;
        }
        const item = misses[answer.index];
        if (!item) continue;
        received++;
        deliver(item, pageAnswer(answer, () => {
          pageCache.set(cacheKeyOf(item), { at: Date.now(), result: answer });
          if (pageCache.size > 500) pageCache.delete(pageCache.keys().next().value);
        }));
      }
    }
    // Every item message must reach the page before this reply does.
    await Promise.all(deliveries);
    if (!(await stillCurrent())) return { stale: true };
    if (received < misses.length) throw new Error("Update the backend to support streamed page checks.");
    return {};
  } finally {
    clearTimeout(timer);
    if (pageRequests.get(key) === entry) pageRequests.delete(key);
  }
}

// One backend batch answer as the page scan expects it. `remember` caches a successful result.
function pageAnswer(answer, remember) {
  if (answer.error) {
    return { error: answer.error, status: answer.status, retryAfter: answer.retry_after ? answer.retry_after * 1000 : undefined };
  }
  // Refuse a server response that may already have launched unsolicited analysis.
  if (!answer.check_id || answer.explanation_id) return { error: "The backend returned an invalid fast result." };
  remember();
  return { result: answer };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("WFC_") || message.type === "WFC_PAGE_START") return;
  pageMessage(message, sender).then(sendResponse, (error) => sendResponse({
    error: error.message, status: error.status, retryAfter: error.retryAfter,
  }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) {
    abortPageRequests(tabId);
    chrome.storage.session.remove(SCAN_KEY(tabId));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  abortPageRequests(tabId);
  chrome.storage.session.remove(SCAN_KEY(tabId));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.password && !changes.backendUrl)) return;
  pageCache.clear();
  for (const entry of pageRequests.values()) entry.controller.abort();
  pageRequests.clear();
});

// The backend holds each request open for up to 25 s while the explanation is written, then
// answers "pending". A few rounds cover any normal LLM call.
const EXPLANATION_ATTEMPTS = 4;

async function fetchExplanation(id) {
  let url;
  try {
    url = (await backendBase()) + "/api/factcheck/explanation/" + encodeURIComponent(id) + "/";
  } catch (e) {
    return { status: "error", error: e.message };
  }
  for (let attempt = 0; attempt < EXPLANATION_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      return { status: "error", error: "Can't reach the backend for the explanation." };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { status: "error", error: data.error || "Backend error (HTTP " + response.status + ")" };
    }
    if (data.status === "done") {
      const explanation = {
        status: "done",
        paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : [],
      };
      // Keep errors absent for older backends so the panel can render their quote-only response.
      if (Array.isArray(data.errors)) {
        explanation.errors = data.errors;
        explanation.unverified_facts = Array.isArray(data.unverified_facts) ? data.unverified_facts : [];
        explanation.incomplete = data.incomplete === true;
      }
      return explanation;
    }
    if (data.status === "error") return { status: "error", error: data.error || "Explanation failed." };
    // "pending": ask again.
  }
  return { status: "error", error: "The explanation took too long." };
}

// Add the explanation to the job, unless a newer check has replaced it in the meantime.
async function updateExplanation(id, explanation) {
  const { job } = await chrome.storage.session.get("job");
  if (job?.status !== "done" || job.result?.explanation_id !== id) return;
  await chrome.storage.session.set({ job: { ...job, explanation } });
}
