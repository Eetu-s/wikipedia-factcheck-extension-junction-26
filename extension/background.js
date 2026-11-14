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
  // Clicking the toolbar icon opens the side panel (where the settings are).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
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
  if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error("The backend URL must start with https:// (http is only allowed for localhost).");
  }
  return base;
}

async function callBackend(text) {
  const { password } = await chrome.storage.local.get("password");
  if (!password) throw new Error("Not logged in.");
  const url = (await backendBase()) + "/api/factcheck/";

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The password travels in the body. Use an https:// backend URL so it is encrypted in transit.
      body: JSON.stringify({ text, password }),
    });
  } catch (e) {
    throw new Error("Can't reach the backend at " + url);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    // Forget the bad password; the side panel then shows the login form again.
    await chrome.storage.local.remove("password");
    throw new Error("Wrong password. Please log in again.");
  }
  if (!response.ok) throw new Error(data.error || "Backend error (HTTP " + response.status + ")");
  return data;
}

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
