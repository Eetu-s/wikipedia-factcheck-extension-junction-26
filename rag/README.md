# rag — Wikipedia semantic search on MariaDB Vector

Takes a question or a statement, turns it into a vector with **bge-m3** (through Ollama), and
returns the closest Wikipedia articles **as JSON**. The search is ported from
[MariaDB/mariadb-vector-wikipedia-rag](https://github.com/MariaDB/mariadb-vector-wikipedia-rag)
and uses the same data: 29,460 *History of Finland* articles in Finnish, Swedish and English, with
ready-made bge-m3 vectors.

The Django backend uses this for `/api/factcheck/` (see `backend/factcheck/checker.py`). Its
container reaches MariaDB and Ollama over the compose network (`mariadb:3306`, `ollama:11434`).

## Setup

```bash
docker compose up -d --wait mariadb ollama   # from the repo root: MariaDB :3307, Ollama :11434
docker compose exec ollama ollama pull bge-m3
```

```bash
cd rag
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m wikirag.load      # tables + articles + categories + vectors, ~190 MB download, a few minutes
```

The downloaded files go to `data/wikirag/`, which is git-ignored. Settings are `RAG_*` env vars,
or a `rag/.env` file (see `.env.example`).

## English paragraphs (optional)

```bash
python -m wikirag.upstash              # files 000-004: ~13k English articles, ~500k paragraphs
python -m wikirag.upstash --files 0-7  # more; safe to re-run, finished files are skipped
```

Loads ready-made bge-m3 paragraph vectors from
[Upstash/wikipedia-2024-06-bge-m3](https://huggingface.co/datasets/Upstash/wikipedia-2024-06-bge-m3)
(English, June 2024) into `chunk` and `chunk_vector`. No embedding is needed: their vectors
match Ollama's bge-m3 exactly (cosine 1.0000) for `"{title}\n{text}"`. The 471 English files
are ordered by page id, so the first ones hold the oldest, mostly core articles. Each file is
~440 MB, downloaded, loaded and deleted in turn. Inserting into the vector index is the slow
part; raise `mhnsw_max_cache_size` (default 16 MB) first.

On the production server, follow [LOAD_ON_SERVER.md](LOAD_ON_SERVER.md).

The backend searches both `article_vector` and `chunk_vector` and keeps the closest articles;
either table may be missing.

## Search

```bash
python -m wikirag "Which peace treaty ended the Winter War?"
python -m wikirag --lang fi "Suomi menetti Karjalan vuonna 1940"
python -m wikirag --category "Suomen sisällissota" --excerpt --limit 3 "prison camps"
python -m wikirag --chunks "Aristotle was a student of Plato"   # English paragraphs
```

Output (stdout is pure JSON; timing goes to stderr, so it can be piped to `jq`):

```json
{
  "query": "Which peace treaty ended the Winter War?",
  "lang": null,
  "category": null,
  "count": 1,
  "results": [
    {
      "rank": 1,
      "title": "Moskovan rauhansopimus (1940)",
      "lang": "fi",
      "page_id": 12345,
      "wikidata_id": "Q...",
      "url": "https://fi.wikipedia.org/wiki/...",
      "distance": 0.3121,
      "other_languages": [
        {"lang": "en", "title": "Moscow Peace Treaty", "url": "https://en.wikipedia.org/wiki/..."}
      ],
      "text": "<article text>",
      "truncated": false
    }
  ]
}
```

`distance` is cosine distance (smaller is closer). With `--excerpt`, `text` is cut to 1,500
characters and `truncated` says whether it was cut. No matches gives `"count": 0, "results": []`.

## From Python (or the Django backend later)

```python
from wikirag import semantic_search, format_results, results_to_dict
from wikirag.db import connect

cur = connect().cursor()
query = "Finland lost Karelia in 1940"
rows = semantic_search(cur, query, lang=None, category=None, limit=5)
data = results_to_dict(rows, query=query, full=True)   # dict; full=False → 1,500-char excerpts
text = format_results(rows, query=query)                # the same, as a JSON string
```

`semantic_search` works with any DB-API cursor that uses `%s` placeholders. If MariaDB becomes
Django's database, `django.db.connection.cursor()` can be passed instead.

## Check quality

```bash
python -m wikirag.evaluate --misses
```

This runs the demo's 37 test questions. The demo measured hit@5 ≈ 76% and hit@10 ≈ 86%.

## How it works

- `article_vector` has a `VECTOR(1024)` column with `VECTOR INDEX … M=16 DISTANCE=cosine`, and
  each search runs `mhnsw_ef_search = 80`. The demo measured these settings at 100% recall@10 in
  about 5 ms; MariaDB's defaults gave 79%.
- The vector `ORDER BY distance LIMIT n` sits in a subquery on `article_vector` alone, and the
  join to `article` comes after. That shape uses the index (~1 ms). A flat join read ~22k rows.
- The category filter walks the category tree with a recursive CTE. It is exact, but slow for
  very large categories.
- The limits come from the demo too: one vector per article finds topics, not single facts
  inside long articles, and 1% of articles were cut at 8,192 tokens when embedded.
