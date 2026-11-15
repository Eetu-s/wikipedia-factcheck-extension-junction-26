# extension frontend

A Chrome extension (Manifest V3). Right-click an article and choose **Fact-check this page**,
or select text and choose **Fact-check selection** to keep using the side panel.

## Page checking

Page checking extracts the current document's loaded article, including content below the
viewport, using bundled Mozilla Readability on a clone with semantic article/main fallbacks.
Navigation, ads, sidebars, hidden content, controls, editable fields, and extension UI are
excluded. Finnish, English, and Swedish use `Intl.Segmenter` sentence boundaries. Original
text-node offsets and DOM Ranges anchor every sentence; repeated phrases and sentences
crossing links or inline formatting do not require text matching or page restructuring.
Recent Chrome versions display the ranges through CSS Custom Highlights. The guide's
sentence selector also provides keyboard access to results.

Sentences begin with subtle gray pending highlights and update progressively:

- **Green / ✓ Supported:** Wikipedia supports the sentence.
- **Red / × Refuted:** Wikipedia contradicts the sentence.
- **Gray / ? Uncertain:** insufficient evidence, ambiguity, or a non-factual sentence.
- **◌ Pending/checking**, **Ⅱ Stopped**, and **! Failed** have distinct labels; failed
  checks also use a wavy gray underline.

While checking, visible text pulses in a soft, 30° diagonal wave moving left to right,
without jumping. The loading cycle lasts 2 seconds, with peak lightening reduced by
30%. Verdict highlights also sweep left to right; each letter lifts 4 pixels and
settles as the color reaches it. Animations respect reduced-motion preferences and
leave the article's text and layout intact. See [animation performance](PERFORMANCE.md)
for the rendering design, profiling results, and a reproducible benchmark.

Hover shows the fast verdict, confidence, and sources. Click a completed sentence, or use
**Open result** in the guide, to pin the result and request deeper analysis. All completed
colors support deeper analysis. Hovering and scanning never start explanations. Repeated
clicks reuse one stored analysis. The overlay shows evidence, explanations, and corrections
without changing the website's text. It uses isolated Shadow DOM styles; Escape dismisses it.
Use the selector or Previous/Next to browse without requesting analysis, then Open result
to analyze the chosen sentence.

The guide includes progress, legend, **Stop**, **Clear**, **Rescan**, and **Retry failed**.
Its **×** closes the overlay and clears the scan. Navigating or switching away from the
tab also closes it; leaving the browser window dismisses the sentence popover.
Up to 32 sentences are checked concurrently in streamed batches of eight, with visible
sentences prioritized and the entire extracted article eventually processed. Completed
sentences free capacity for the next batch without waiting for every slow response; at most
six batch requests remain open. Sentence positions are reused until scrolling, resizing,
resource loading, or page changes require new measurements. Checks use the saved password
with `/api/factcheck/batch/`, which bypasses the public API and production proxy rate limits.
Upstream model-provider rate limits still pause the queue with bounded retries.
Sentences go to `/api/factcheck/batch/` in batches of 8, with up to 4 batches (32 sentences)
in flight. Visible sentences go first, and the whole extracted article is eventually
processed. Each answer streams back as soon as its decision finishes, so a batch never waits
for its slowest sentence. Checks use the saved password, which bypasses the public API and
production proxy rate limits. Upstream model-provider rate limits still pause the queue with
bounded retries.
Article/context changes invalidate the snapshot; appended content is checked only after
an explicit **Rescan**. Clear, navigation, and restarting discard stale responses. Cached
fast results include the original sentence, location, page, context, tab, and backend and
expire after 15 minutes. The injected script is added only after the context-menu command.
Chrome's protected internal pages cannot be scanned.

## Selection checking

The fast verdict appears first. For refuted selections, **Why it's refuted** shows a loading
message while deeper analysis checks each factual assertion against the local Wikipedia
dataset. It then highlights incorrect phrases and shows one explanation per error combining
the misinformation and correct fact in the selection's language, followed by short Wikipedia
quotations with article links. Facts without enough evidence
are listed separately; failed or timed-out searches are marked as incomplete.

The fast verdict uses `gemini-decision-1`. Deeper analysis uses `GEMINI_EXPLAIN_MODEL`
(`gemini-3.5-flash-lite` by default). Apply backend migrations when updating an existing
installation (`docker compose exec backend python manage.py migrate`), and reload the
unpacked extension after updating its files. Docker startup also applies migrations.

## Files

- `manifest.json`: extension config and permissions.
- `background.js`: adds the right-click menu items and sends the requests: `POST /api/factcheck/` for selections, `POST /api/factcheck/batch/` for page scans.
- `vendor/Readability.js`: bundled Mozilla article extractor (see `vendor/README.md` for license).
- `article.js`: article provenance, locale-aware sentences, original ranges, and snapshot validation.
- `page-scan.js`: page queue, highlighting, cancellation, Rescan, and click-only deep analysis.
- `page-ui.js`: Shadow DOM guide and accessible sentence overlays.
- `sidepanel.html` / `sidepanel.js`: shows the result and the settings (backend URL and password).
- `sidepanel.css`, `tokens.css`, `base.css`: the side panel's styles. Colours, spacing and type are tokens in `tokens.css`; change a value there, not in `sidepanel.css`. The theme is Hallmark's Terrazzo.

## Load it

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension/` folder.
3. Click the extension's toolbar icon to open the side panel. Enter the backend URL (default `https://klausde.tech`, or `http://localhost:8000` for local development) and the password, then click **Log in**.
4. Select some text, right-click it and choose **Fact-check selection**.
5. Or right-click an article and choose **Fact-check this page**. Hover a highlight for its
   fast result; click it for deeper analysis.

After you edit the code, click the reload icon on the extension's card in `chrome://extensions`.

## Password

Fact-check requests send a JSON body `{"text": "...", "password": "..."}`. Deep-start
requests also send the password in JSON; page-result polls use an Authorization header.
The backend rejects a wrong or missing password with HTTP 401. The backend stores only a
hash of the password (`FACTCHECK_PASSWORD_HASH`, see `backend/.env.example`).

You enter the password once. It is saved in `chrome.storage.local`, which only this extension can read (web pages can't, unlike cookies or `localStorage`). It stays saved after a browser restart until you click **Log out**, or until the backend answers 401, which deletes it and shows the login form again.

The extension refuses to send the password to an `http://` URL unless the host is `localhost` or `127.0.0.1`, so the deployed backend must use **https://**.

## Page API

Apply migration `0003_pagecheck` before using page scans:

```bash
docker compose exec backend python manage.py migrate
```

The existing authenticated `POST /api/factcheck/` accepts additive fields:

```json
{
  "password": "...",
  "text": "It was completed in 1889.",
  "sentence_id": "wfc-...",
  "fast_only": true,
  "context": {
    "page_title": "Paris landmarks",
    "section_heading": "Eiffel Tower",
    "paragraph": "The Eiffel Tower stands in Paris. It was completed in 1889.",
    "previous": "Bounded preceding text.",
    "next": "Bounded following text.",
    "publication_date": "2026-11-14",
    "language": "en"
  }
}
```

It returns `decision`, `confidence`, `sources`, `explanation_id: null`, `check_id`, and
`sentence_id`. The immutable check retains exact wording, context, and retrieved Wikipedia
evidence. Only `POST /api/factcheck/check/<check_id>/analyze/` with `{"password":"..."}`
starts deep work; the action is idempotent across repeated requests. Poll
`GET /api/factcheck/check/<check_id>/` with `Authorization: Bearer <password>` for
`not_requested`, `pending`, `done`, or `error`. Completed responses include `explanation`,
`paragraphs`, `errors`, `unverified_facts`, and `incomplete`. Correction offsets use Unicode
code points into the saved original sentence and are validated without relocating phrases.
Polling and cached results never start analysis.

Page scans use `POST /api/factcheck/batch/` with up to ten `{text, sentence_id, context}`
items and the saved password. With `stream: true`, each NDJSON line carries its original
`index` and either the fast result or an error with optional `retry_after` seconds. Results
are stored before delivery so deeper analysis can start immediately. Without streaming,
the response is `{"results": [...]}` in input order. A batch shares one embedding call;
retrieval ranks candidates first, then loads the selected Wikipedia bodies once per unique
article, retaining each sentence's matching paragraphs.

Page scans use `POST /api/factcheck/batch/` with up to ten `{text, sentence_id, context}`
items and the saved password. With `stream: true`, each NDJSON line carries its original
`index` and either the fast result or an error with optional `retry_after` seconds. Results
are stored before delivery so deeper analysis can start immediately. Without streaming,
the response is `{"results": [...]}` in input order. A batch shares one embedding call;
retrieval ranks candidates first, then loads the selected Wikipedia bodies once per unique
article, retaining each sentence's matching paragraphs.

Page scans use `POST /api/factcheck/batch/`, which runs the same fast check for up to 10
sentences per request:

```json
{"password": "...", "stream": true,
 "items": [{"text": "It was completed in 1889.", "sentence_id": "wfc-...", "context": {"...": "..."}}]}
```

The batch embeds all its retrieval queries in one Ollama call and runs the model decisions in
parallel. With `"stream": true` the response is NDJSON: one `{"index": <item>, ...answer}`
line per sentence, in the order the decisions finish. Each answer is the single-sentence
response above, or `{"sentence_id", "error", "status": 429 | 502, "retry_after"}`. Each
`check_id` is saved before its line is sent, so deeper analysis is available at once. Without
`stream`, the response is `{"results": [...]}` in request order.

The retrieval query is the target sentence plus the last 300 characters of the previous
sentence and the first 150 of the section heading and the page title. The paragraph and next sentence go only to the model:
a long paragraph would slow embedding and drown out the sentence. Model inputs separate TARGET SENTENCE,
PAGE CONTEXT, and WIKIPEDIA EVIDENCE. Context may resolve a subject, pronoun, or relative
date; it cannot serve as evidence. The local paragraph's subject takes precedence over the
page title. Requests without `fast_only` retain the existing selection behavior.

## Tests

Backend contract tests mock Wikipedia/model calls and require no external services:

```bash
docker compose exec backend python manage.py test
node extension/tests/background.test.cjs
node extension/tests/page-queue.test.cjs
```

Browser tests exercise extraction, real DOM Ranges, the scan controller, and Shadow DOM
interaction with a mocked extension transport. Install `playwright-core` in a temporary
directory; no npm dependencies are needed to load the extension itself:

```bash
npm install --prefix /tmp/wfc-tests playwright-core
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/article.test.cjs
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/page-ui.test.cjs
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/scan-animation.test.cjs
```

Profile a synthetic 1,800-sentence scan with Chrome's performance counters:

```bash
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/scan-performance.cjs
```

The browser tests default to Chrome's macOS application path. Set `CHROME_PATH` to your
Chrome/Chromium executable on other systems. Live model quality still depends on the
configured Gemini models and the Finnish, English, and Swedish Wikipedia data loaded in RAG.
