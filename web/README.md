# website frontend

The extension's fact-check as a web page. Type or paste a claim, press **Fact-check**, and get the verdict, confidence, sources and the explanation (or, for refuted claims, the factual errors with Wikipedia evidence). No login.

## Files

- `public/`: the site (`index.html`, `app.js`, `styles.css`, plus `tokens.css` and `base.css`, copies of the extension's theme).
- `nginx.conf`, `Dockerfile`: nginx serves `public/` and forwards `/api/`, `/static/`, `/accuracy`, `/accuracy/`, and `/accuracy.css` to the backend, so the pages and API share one origin (no CORS). `/admin` remains hidden.

## Run it

```bash
docker compose up --build        # website at http://localhost:8080
```

In development `web/public/` is bind-mounted, so edits show on reload. In production (`docker-compose.prod.yml`) Traefik sends the whole host to this service, with the rate-limit middleware, and nginx forwards the API paths to the backend.

## No password

The page calls `POST /api/factcheck-ratelimit/`, which needs no password. The backend accepts at most one request per second across all visitors and answers HTTP 429 to the rest; the page waits and retries a few times before showing an error. The explanation endpoint needs no password either (its id is a random UUID).

The rendering code in `public/app.js` is copied from `extension/sidepanel.js`; keep them in step when the response format changes.
