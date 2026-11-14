// Website frontend: the same fact-check as the browser extension, but the claim comes from a
// text field instead of a page selection, and no login is needed.
//
// It calls the public, rate-limited endpoint (no password): POST /api/factcheck-ratelimit/ allows
// one request per second across all visitors and answers 429 to the rest.
// The page is served from the same origin as the API, so no CORS setup is needed.
// The rendering code below is shared in spirit with ../../extension/sidepanel.js; keep them in step.

const API = "/api/factcheck/";
const CHECK_URL = "/api/factcheck-ratelimit/";

const checkForm = document.getElementById("check");
const claimInput = document.getElementById("claim");
const submitButton = document.getElementById("submit");
const resultEl = document.getElementById("result");

// --- Calling the backend ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Another visitor may have used this second's slot (HTTP 429): wait as told and try again.
const RATELIMIT_ATTEMPTS = 4;

async function callBackend(text) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(CHECK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      throw new Error("Can't reach the backend.");
    }
    if (response.status === 429 && attempt < RATELIMIT_ATTEMPTS) {
      const wait = Number(response.headers.get("Retry-After")) || 1;
      await sleep(wait * 1000 + Math.random() * 500);
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 429) throw new Error("The service is busy right now. Please try again in a moment.");
    if (!response.ok) throw new Error(data.error || "Backend error (HTTP " + response.status + ")");
    return data;
  }
}

// The backend holds each request open for up to 25 s while the explanation is written, then
// answers "pending". A few rounds cover any normal LLM call.
const EXPLANATION_ATTEMPTS = 4;

async function fetchExplanation(id) {
  const url = API + "explanation/" + encodeURIComponent(id) + "/";
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
      // Keep errors absent for older backends so the page can render their quote-only response.
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

// --- Running a check ---

// Each check gets a number. If a newer check starts, older ones stop updating the page.
let runId = 0;

async function checkText(text) {
  const id = ++runId;
  const isCurrent = () => id === runId;
  submitButton.disabled = true;
  showJob({ status: "loading", text });

  let result;
  try {
    result = await callBackend(text);
  } catch (e) {
    if (!isCurrent()) return;
    submitButton.disabled = false;
    showJob({ status: "error", text, error: e.message });
    return;
  }
  if (!isCurrent()) return;
  submitButton.disabled = false;

  // The verdict shows first; the explanation follows when it is ready.
  const explanationId = result.explanation_id;
  const job = { status: "done", text, result, explanation: explanationId ? { status: "loading" } : undefined };
  showJob(job);
  if (!explanationId) return;
  const explanation = await fetchExplanation(explanationId);
  if (!isCurrent()) return;
  showJob({ ...job, explanation });
}

checkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = claimInput.value.trim();
  if (text) checkText(text);
});

// Ctrl/Cmd+Enter submits from inside the text field.
claimInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    checkForm.requestSubmit();
  }
});

// --- Result ---

// Small helper: an element with a class and text. All text goes in via textContent, never innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// "NOT ENOUGH INFO" -> "Can't be confirmed from Wikipedia", "SUPPORTED" -> "Supported"
function decisionLabel(decision) {
  if (decision === "NOT ENOUGH INFO") return "Can't be confirmed from Wikipedia";
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
  // Without a verdict the links aren't evidence, just the articles the model read.
  sources.append(el("h2", null, result.decision === "NOT ENOUGH INFO" ? "Articles checked" : "Sources"));
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
        el("p", "error-explanation", String(error.explanation || error.corrected_text || "")));
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


function showJob(job) {
  resultEl.replaceChildren();
  if (job.status === "loading") resultEl.append(renderLoading(job));
  else if (job.status === "error") resultEl.append(renderError(job));
  else resultEl.append(renderDone(job));
}
