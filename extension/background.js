// Background service worker: adds the right-click menu item and calls the backend.
//
// Flow: user selects text -> right-click "Fact-check selection" -> side panel opens ->
// we POST the text to the backend -> the result is saved to chrome.storage.session ->
// the side panel (sidepanel.js) sees the change and shows it.

const DEFAULT_BACKEND_URL = "http://localhost:8000";

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
  try {
    const result = await callBackend(text);
    await chrome.storage.session.set({ job: { status: "done", text, result } });
  } catch (e) {
    await chrome.storage.session.set({ job: { status: "error", text, error: e.message } });
  }
}

async function callBackend(text) {
  // The backend URL and password are entered by the user in the side panel's login form.
  const { backendUrl, password } = await chrome.storage.local.get(["backendUrl", "password"]);
  if (!password) throw new Error("Not logged in.");

  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, "") + "/api/factcheck/";
  // Never send the password unencrypted over the internet. Plain http is only OK for local dev.
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error("The backend URL must start with https:// (http is only allowed for localhost).");
  }

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
