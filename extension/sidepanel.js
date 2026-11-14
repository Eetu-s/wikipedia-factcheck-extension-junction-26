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

const DEFAULT_BACKEND_URL = "https://klausde.tech";

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

// Small helper: an element with a class and text. All text goes in via textContent, never innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// "NOT ENOUGH INFO" -> "Not enough info"
function decisionLabel(decision) {
  const words = String(decision).toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A source URL becomes an article title (from a Wikipedia path) plus its host.
// Anything that is not an http(s) URL is shown as plain text, never as a link.
function sourceItem(source) {
  const item = el("li");
  item.append(...sourceLink(source));
  return item;
}

// The nodes for one source: [link, host], or [plain text] when it isn't an http(s) URL.
function sourceLink(source, articleTitle) {
  let url;
  try {
    url = new URL(source);
  } catch (e) {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return [el("span", null, String(source))];
  }
  let title = url.href;
  const match = url.pathname.match(/\/wiki\/(.+)$/);
  if (match) {
    try {
      title = decodeURIComponent(match[1]).replace(/_/g, " ");
    } catch (e) {
      title = match[1].replace(/_/g, " ");
    }
  }
  const link = el("a", null, articleTitle || title);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return [link, el("span", "host", url.hostname)];
}

function renderClaim(text, errors = []) {
  const claim = el("div", "claim");
  const quote = el("blockquote");
  // Backend offsets count Unicode code points, not JavaScript UTF-16 code units.
  const characters = Array.from(text);
  const ranges = [];
  errors.forEach((error, index) => {
    if (!error || !Number.isInteger(error.start) || !Number.isInteger(error.end)
        || error.start < 0 || error.end <= error.start || error.end > characters.length
        || characters.slice(error.start, error.end).join("") !== error.original_text) return;
    ranges.push({ start: error.start, end: error.end, numbers: [index + 1] });
  });
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      previous.numbers.push(...range.numbers);
    } else {
      merged.push({ ...range, numbers: [...range.numbers] });
    }
  }
  let cursor = 0;
  for (const range of merged) {
    quote.append(document.createTextNode(characters.slice(cursor, range.start).join("")));
    const mark = el("mark", "factual-error", characters.slice(range.start, range.end).join(""));
    for (const number of range.numbers.sort((a, b) => a - b)) {
      const reference = el("a", "error-reference", `[${number}]`);
      reference.href = "#factual-error-" + number;
      reference.setAttribute("aria-label", "Read explanation for factual error " + number);
      mark.append(reference);
    }
    quote.append(mark);
    cursor = range.end;
  }
  quote.append(document.createTextNode(characters.slice(cursor).join("")));
  claim.append(el("span", "label", "Claim"), quote);
  return claim;
}

function renderDone(job) {
  const result = job.result;
  const plate = el("section", "plate");
  plate.setAttribute("aria-label", "Fact-check result");
  const errors = result?.decision === "REFUTED" && Array.isArray(job.explanation?.errors)
    ? job.explanation.errors : [];
  plate.append(renderClaim(job.text, errors));

  // The response format is { decision, confidence, sources }. If it ever changes shape, show it raw.
  if (!result || typeof result.decision !== "string") {
    plate.append(el("pre", "raw", JSON.stringify(result, null, 2)));
    return plate;
  }

  const verdict = el("div", "verdict");
  verdict.dataset.decision = result.decision;
  verdict.append(el("span", "label", "Verdict"), el("span", "decision", decisionLabel(result.decision)));
  plate.append(verdict);

  if (typeof result.confidence === "number" && Number.isFinite(result.confidence)) {
    const value = Math.min(1, Math.max(0, result.confidence));
    const percent = Math.round(value * 100);
    const confidence = el("div", "confidence");
    const row = el("div", "row");
    row.append(el("span", null, "Confidence"), el("span", "figure", percent + "%"));
    const measure = el("div", "measure");
    measure.setAttribute("role", "meter");
    measure.setAttribute("aria-label", "Confidence");
    measure.setAttribute("aria-valuemin", "0");
    measure.setAttribute("aria-valuemax", "100");
    measure.setAttribute("aria-valuenow", String(percent));
    const fill = el("span");
    fill.style.setProperty("--v", String(value));
    measure.append(fill);
    // The bar takes the verdict's colour through the same data attribute.
    confidence.dataset.decision = result.decision;
    confidence.append(row, measure);
    plate.append(confidence);
  }

  // Show deeper-analysis progress directly below the fast verdict and confidence.
  if (job.explanation) plate.append(renderExplanation(result.decision, job.explanation));

  const sources = el("div", "sources");
  sources.append(el("h2", null, "Sources"));
  const list = Array.isArray(result.sources) ? result.sources : [];
  if (list.length === 0) {
    sources.append(el("p", "none", "No sources were returned."));
  } else {
    const ol = el("ol");
    ol.append(...list.map(sourceItem));
    sources.append(ol);
  }
  plate.append(sources);

  return plate;
}

function explanationField(label, text, className) {
  const field = el("p", className);
  field.append(el("strong", null, label + ": "), document.createTextNode(String(text ?? "")));
  return field;
}

function renderCorrections(section, explanation) {
  const errors = explanation.errors;
  if (explanation.incomplete) {
    section.append(el("p", "analysis-notice", "This deeper analysis is incomplete. The findings below cover only the facts that could be assessed."));
  }
  if (errors.length === 0) {
    section.append(el("p", "none", "The deeper analysis could not substantiate the initial refuted verdict with a Wikipedia-backed correction."));
  } else {
    const list = el("ol", "corrections");
    errors.forEach((error, index) => {
      const item = el("li", "correction");
      const heading = el("h3", null, "Factual error " + (index + 1));
      heading.id = "factual-error-" + (index + 1);
      heading.tabIndex = -1;
      item.append(heading,
        explanationField("Incorrect", error.original_text, "incorrect"),
        explanationField("Why it's wrong", error.explanation),
        explanationField("Correction", error.corrected_text, "corrected-text"));
      const evidence = el("div", "evidence");
      evidence.append(el("span", "evidence-label", "Wikipedia evidence"));
      for (const entry of Array.isArray(error.evidence) ? error.evidence : []) {
        const quote = el("blockquote", null, String(entry.quote ?? ""));
        const cite = el("div", "cite");
        cite.append(...sourceLink(entry.source, entry.title));
        evidence.append(quote, cite);
      }
      item.append(evidence);
      list.append(item);
    });
    section.append(list);
  }
  const unverified = Array.isArray(explanation.unverified_facts) ? explanation.unverified_facts : [];
  if (unverified.length) {
    const details = el("details", "unverified");
    details.append(el("summary", null, "Facts that could not be fully verified (" + unverified.length + ")"));
    const list = el("ul");
    for (const fact of unverified) {
      const item = el("li");
      item.append(el("blockquote", null, String(fact.text ?? "")), el("p", "none", String(fact.reason ?? "")));
      list.append(item);
    }
    details.append(list);
    section.append(details);
  }
}

// Refuted results get individual corrections; older responses and supported results use quotes.
function renderExplanation(decision, explanation) {
  const section = el("div", "explanation");
  section.dataset.decision = decision;
  const heading = decision === "REFUTED" ? "Why it's refuted" : decision === "SUPPORTED" ? "Why it's supported" : "Why";
  section.append(el("h2", null, heading));

  if (explanation.status === "loading") {
    section.setAttribute("aria-busy", "true");
    const skeleton = el("div", "skeleton");
    skeleton.setAttribute("aria-hidden", "true");
    skeleton.append(el("span"), el("span"), el("span"));
    const message = decision === "REFUTED"
      ? "Analyzing factual errors and finding Wikipedia-backed corrections…"
      : "Finding the paragraphs behind the verdict…";
    section.append(skeleton, el("p", "status", message));
    return section;
  }
  if (explanation.status === "error") {
    section.append(el("p", "none", "The deeper analysis could not be completed: " + explanation.error));
    return section;
  }
  if (decision === "REFUTED" && Array.isArray(explanation.errors)) {
    renderCorrections(section, explanation);
    return section;
  }
  const paragraphs = Array.isArray(explanation.paragraphs) ? explanation.paragraphs : [];
  if (paragraphs.length === 0) {
    section.append(el("p", "none", "No paragraphs were returned."));
    return section;
  }
  const list = el("ol");
  for (const p of paragraphs) {
    const item = el("li");
    const quote = el("blockquote", null, String(p.paragraph ?? ""));
    const cite = el("div", "cite");
    cite.append(...sourceLink(p.source));
    item.append(quote, cite);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderLoading(job) {
  const plate = el("section", "plate");
  plate.append(renderClaim(job.text));
  const skeleton = el("div", "skeleton");
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.append(el("span"), el("span"), el("span", "bar"));
  plate.append(skeleton, el("p", "status", "Checking…"));
  return plate;
}

function renderError(job) {
  const plate = el("section", "plate failed");
  plate.append(renderClaim(job.text), el("p", "error", job.error));
  return plate;
}

function renderEmpty() {
  const empty = el("div", "empty");
  const hint = el("p");
  hint.append("Select text on a page, right-click, and choose ");
  hint.append(el("strong", null, "Fact-check selection"));
  hint.append(".");
  empty.append(hint);
  return empty;
}

function showJob(job) {
  // Also show errors (e.g. "Wrong password") above the login form.
  loginError.textContent = job?.status === "error" ? job.error : "";
  resultEl.replaceChildren();
  if (!job) {
    resultEl.append(renderEmpty()); // nothing checked yet, or the job was cleared
    return;
  }
  if (job.status === "loading") resultEl.append(renderLoading(job));
  else if (job.status === "error") resultEl.append(renderError(job));
  else resultEl.append(renderDone(job));
}

// --- Keep the panel in sync with storage ---

showLoginOrMain();
chrome.storage.session.get("job").then(({ job }) => showJob(job));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.password) showLoginOrMain();
  if (area === "session" && changes.job) showJob(changes.job.newValue);
});
