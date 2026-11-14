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
