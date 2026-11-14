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

// --- Login / logout ---

async function showLoginOrMain() {
  const { backendUrl, password } = await chrome.storage.local.get(["backendUrl", "password"]);
  const loggedIn = Boolean(password);
  loginForm.hidden = loggedIn;
  mainEl.hidden = !loggedIn;
  backendUrlInput.value = backendUrl || "";
  passwordInput.value = ""; // never put the saved password back into the page
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    backendUrl: backendUrlInput.value.trim(),
    password: passwordInput.value.trim(),
  });
});

document.getElementById("logout").addEventListener("click", () => {
  chrome.storage.local.remove("password");
});

// --- Result ---

function showJob(job) {
  if (!job) return;
  // Also show errors (e.g. "Wrong password") above the login form.
  document.getElementById("loginError").textContent = job.status === "error" ? job.error : "";
  resultEl.replaceChildren();

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
