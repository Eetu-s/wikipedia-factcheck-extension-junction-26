# Agent instructions

## Project layout

- `backend/` — Django project (`config/` settings/urls, `factcheck/` app). API is served under `/api/`.
- `rag/` — Wikipedia semantic search (`wikirag` package, MariaDB Vector + Ollama). The backend image includes `rag/wikirag` and uses it in `/api/factcheck/`.
- `extension/` — browser extension frontend.
- `data/` — local RAG data and indexes. Git-ignored; never commit its contents.

## Running the backend

With Docker (preferred). `/api/factcheck/` also needs the RAG stack running and loaded (see `rag/README.md`) and `GEMINI_API_KEY` in `backend/.env`:

```bash
docker compose -f rag/docker-compose.yml up -d --wait   # MariaDB :3307, Ollama :11434
docker compose up --build                              # http://localhost:8000/api/health/
docker compose exec backend python manage.py test
docker compose exec backend python manage.py makemigrations
docker compose exec backend python manage.py createsuperuser
```

Source in `backend/` is bind-mounted, so code changes reload automatically. Rebuild (`--build`) after changing `backend/requirements.txt`. Optional env overrides go in `backend/.env` (see `backend/.env.example`).

Without Docker:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && python manage.py migrate && python manage.py runserver
python manage.py test   # run tests
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

- **type** — one of:
  - `feat` new feature
  - `fix` bug fix
  - `docs` documentation only
  - `style` formatting, no code change
  - `refactor` code change that neither fixes a bug nor adds a feature
  - `perf` performance improvement
  - `test` adding or fixing tests
  - `build` build system or dependencies
  - `ci` CI configuration
  - `chore` maintenance that doesn't touch src or tests
  - `revert` reverts a previous commit
- **scope** (optional, recommended) — the area touched: `backend`, `rag`, `extension`, or `repo` for cross-cutting changes.
- **summary** — imperative mood, lowercase, no trailing period, ≤ 72 characters (e.g. `add`, not `added`/`adds`).
- **body** — explain *what* and *why*, not *how*. Wrap at 72 characters.
- **breaking changes** — add `!` after the type/scope (`feat(backend)!: ...`) and a `BREAKING CHANGE: <description>` footer.
- Keep commits focused: one logical change per commit. Don't mix refactors with features.

Examples:

```
feat(rag): add chunking for wikipedia article sections
fix(backend): return 400 when claim text is empty
docs(repo): describe local setup in README
build(backend)!: upgrade to django 6

BREAKING CHANGE: requires python 3.12+
```
