# wikipediafactcheck

Fact checking for Wikipedia articles.

| Directory    | What                                         |
|--------------|----------------------------------------------|
| `backend/`   | Django API                                   |
| `rag/`       | Retrieval layer (ingestion + vector search)  |
| `extension/` | Browser extension frontend                   |
| `web/`       | Website frontend (nginx, no login)           |
| `data/`      | Local RAG data and indexes (git-ignored)     |

See [AGENTS.md](AGENTS.md) for setup and contribution conventions.

## How a check works

1. The claim (for page scans, the sentence plus a little page context) is embedded with
   bge-m3 through Ollama.
2. MariaDB Vector finds the closest Wikipedia text in two datasets: *History of Finland*
   articles in Finnish, Swedish and English, and 500,000 paragraphs of English Wikipedia.
   The two rankings are merged into the 3 best articles. See [rag/README.md](rag/README.md).
3. `gemini-decision-1` decides SUPPORTED, REFUTED or NOT ENOUGH INFO from those articles only,
   and rates which articles bear on it; those become the sources.
4. On request, `GEMINI_EXPLAIN_MODEL` quotes the evidence and, for refuted claims, lists each
   factual error with the correct fact.

The model sees only the retrieved text, so claims about topics outside the data should get
NOT ENOUGH INFO rather than a guess. Results further than cosine distance 0.5 are not passed on.

| Endpoint | Used by |
|---|---|
| `POST /api/factcheck/` | extension selection checks (password) |
| `POST /api/factcheck/batch/` | extension page scans, streamed (password) |
| `POST /api/factcheck-ratelimit/` | website and extension selection checks without a password, one request per second overall |
| `GET /accuracy` | accuracy report (below) |

## Accuracy report

`/accuracy` is a read-only report of the 100 true and 100 false statements in
`backend/factcheck/benchmark/`. It uses the same verdict and correction functions as the
extension. File labels are used only for scoring, never included in the model input.

Run the evaluation explicitly, once, after loading the RAG data and configuring
`GEMINI_API_KEY` in `backend/.env`:

```bash
docker compose exec backend python manage.py run_accuracy
```

Every attempt is saved before calling the model. Repeating this command refuses to run.
`--resume` processes only statements never attempted, skipping interrupted or failed calls;
`--rerun` explicitly authorizes a fresh evaluation and archives the previous result. A
correction is requested once for each refuted verdict. The fifth column shows the existing
deeper analysis's combined explanation and correction, with Wikipedia links.

Results live beside the Django database (`backend/accuracy-results.json` locally,
`/data/accuracy-results.json` in production), overridable with `ACCURACY_RESULTS_PATH`.
Keep the local `backend/accuracy-results.json` with the source when deploying the report:
the Docker image includes it as a read-only fallback when the production volume has no
saved run. Existing volume results take precedence. Page loads, deployments, and backend
startup never invoke the evaluation; the report has no run endpoint or browser scripts.

SUPPORTED is the positive class. Overall accuracy counts abstentions and failed/interrupted
attempts as incorrect; precision, recall, F1, and specificity use decisive verdicts only.
Abstentions, coverage, and failed-check counts are shown separately.
