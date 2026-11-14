// Side panel: a login form until a password is saved, then the latest check result.
//
// The password is kept in chrome.storage.local: private to this extension (web pages can't
// read it, unlike cookies or localStorage) and kept across browser restarts.
// background.js deletes it when the backend says it's wrong, which brings back the login form.

const loginForm = document.getElementById("login");
const mainEl = document.getElementById("main");
const backendUrlInput = document.getElementById("backendUrl");
const passwordInput = document.getElementById("password");
const resultEl = document.getElementById("result");

const DEFAULT_BACKEND_URL = "http://localhost:8000";

// --- Login / logout ---

async function showLoginOrMain() {
  const { backendUrl, password } = await chrome.storage.local.get(["backendUrl", "password"]);
  const loggedIn = Boolean(password);
  loginForm.hidden = loggedIn;
  mainEl.hidden = !loggedIn;
  backendUrlInput.value = backendUrl || "";
  passwordInput.value = ""; // never put the saved password back into the page
}

const loginError = document.getElementById("loginError");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const backendUrl = backendUrlInput.value.trim();
  const password = passwordInput.value.trim();
  await chrome.storage.session.remove("job"); // drop the previous result/error

  // Check the password before saving it. The backend checks the password before the text,
  // so an empty text gives 401 for a wrong password and 400 for a correct one.
  // Same https rule as background.js: don't send the password over plain http (except localhost).
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, "") + "/api/factcheck/";
  let status;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
      throw new Error("not https");
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", password }),
    });
    status = response.status;
  } catch (e) {
    loginError.textContent = "Can't use the backend at " + url + " (use https:// unless it is localhost).";
    return;
  }
  if (status === 401) {
    loginError.textContent = "Wrong password. Please try again.";
    passwordInput.value = "";
    return;
  }
  await chrome.storage.local.set({ backendUrl, password });
});

document.getElementById("logout").addEventListener("click", () => {
  chrome.storage.local.remove("password");
});

// --- Result ---

function showJob(job) {
  // Also show errors (e.g. "Wrong password") above the login form.
  loginError.textContent = job?.status === "error" ? job.error : "";
  resultEl.replaceChildren();
  if (!job) return; // job was cleared

  const quote = document.createElement("blockquote");
  quote.textContent = job.text;
  resultEl.append(quote);

  const body = document.createElement(job.status === "done" ? "pre" : "p");
  if (job.status === "loading") body.textContent = "Checking…";
  if (job.status === "error") {
    body.textContent = job.error;
    body.className = "error";
  }
  // The backend response format isn't decided yet, so just show the raw JSON for now.
  if (job.status === "done") body.textContent = JSON.stringify(job.result, null, 2);
  resultEl.append(body);
}

// --- Keep the panel in sync with storage ---

showLoginOrMain();
chrome.storage.session.get("job").then(({ job }) => showJob(job));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.password) showLoginOrMain();
  if (area === "session" && changes.job) showJob(changes.job.newValue);
});
