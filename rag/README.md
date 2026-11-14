# rag: Wikipedia search on MariaDB Vector

The `wikirag` package turns a claim or question into a vector with **bge-m3** (through Ollama)
and finds the closest Wikipedia text in MariaDB. The backend uses it for every fact check
(`backend/factcheck/checker.py`); its container reaches MariaDB and Ollama over the compose
network (`mariadb:3306`, `ollama:11434`).

Two datasets, both with ready-made bge-m3 vectors:

| Data | Tables | Size | Vectors |
|---|---|---|---|
| *History of Finland* in Finnish, Swedish and English, from [MariaDB/mariadb-vector-wikipedia-rag](https://github.com/MariaDB/mariadb-vector-wikipedia-rag) | `article`, `article_vector`, `category_link`, `article_category` | 29,460 articles, ~0.4 GB | one per article |
| English Wikipedia, oldest 12,637 articles (Aristotle, Abraham Lincoln, Alabama, …), from [Upstash/wikipedia-2024-06-bge-m3](https://huggingface.co/datasets/Upstash/wikipedia-2024-06-bge-m3), June 2024 | `chunk`, `chunk_vector` | 500,000 paragraphs, ~4.2 GB | one per paragraph |

Either dataset can be missing; the search uses what is loaded.

## Setup

```bash
docker compose up -d --wait mariadb ollama   # from the repo root: MariaDB :3307, Ollama :11434
docker compose exec ollama ollama pull bge-m3
```

```bash
cd rag
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m wikirag.load      # History of Finland: ~190 MB download, ~5 minutes
python -m wikirag.upstash   # English paragraphs: 5 × 440 MB, ~45 minutes
```

Downloads go to `data/wikirag/`, which is git-ignored. Settings are `RAG_*` env vars, or a
`rag/.env` file (see `.env.example`).

`wikirag.upstash` loads files 000-004 by default (`--files 0-7` for more; each file adds
~100,000 paragraphs and ~0.9 GB). It downloads, loads and deletes one file at a time, and is
safe to re-run: finished files are recorded in `loaded_file` and skipped. Inserting into the
vector index is the slow part and slows down as the index grows (locally 3, 5, 7, 9 and 21
minutes per file). On the production server, follow [LOAD_ON_SERVER.md](LOAD_ON_SERVER.md).

## Search

```bash
python -m wikirag "Which peace treaty ended the Winter War?"
python -m wikirag --lang fi "Suomi menetti Karjalan vuonna 1940"
python -m wikirag --category "Suomen sisällissota" --excerpt --limit 3 "prison camps"
python -m wikirag --chunks "Aristotle was a student of Plato"   # English paragraphs
```

stdout is JSON; timing goes to stderr, so the output can be piped to `jq`:

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
characters and `truncated` says whether it was cut. `--chunks` results also have `matched`, the
paragraph numbers that matched, and `wikidata_id: null`.

## From Python

```python
from wikirag import chunk_search, embed, format_results, semantic_search
from wikirag.db import connect

cur = connect().cursor()
query = "Finland lost Karelia in 1940"
vector = embed(query)                                    # embed once, search both
articles = semantic_search(cur, query, limit=5, vector=vector)
paragraphs = chunk_search(cur, query, limit=5, vector=vector)
print(format_results(articles, query=query))             # JSON string; results_to_dict() for the dict
```

Both functions take any DB-API cursor with `%s` placeholders.

## Check quality

```bash
python -m wikirag.evaluate --misses
```

Runs the 37 test questions from MariaDB's demo against the article search. The demo measured
hit@5 ≈ 76% and hit@10 ≈ 86%. For whole fact checks, see the accuracy report in the root
[README](../README.md).

## How it works

- **Article search** (`semantic_search`): `article_vector` has a `VECTOR(1024)` column with
  `VECTOR INDEX … M=16 DISTANCE=cosine`, searched with `mhnsw_ef_search = 80`. MariaDB's demo
  measured these settings at 100% recall@10 in about 5 ms; the defaults gave 79%.
- **Paragraph search** (`chunk_search`): the closest 40 paragraphs in `chunk_vector`, grouped by
  article. Each article's text is the whole article when it fits in 40,000 characters,
  otherwise its first two paragraphs plus each matched paragraph and the two on either side.
- **Query shape:** the vector `ORDER BY distance LIMIT n` runs in a subquery on the vector table
  alone, and the join to the text comes after. That shape uses the index (~1 ms); a flat join
  read ~22,000 rows.
- **Merging** (in the backend, `fuse_rankings`): article and paragraph distances aren't
  comparable, since a whole-article vector lies further from any claim than a paragraph
  vector. The two rankings therefore take turns, the one with the closest result first. Results
  further than 0.5 are dropped, and an article found by both counts once. Adding the paragraphs
  raised the 200-claim benchmark from 157 to 172 correct and cut wrong verdicts from 4 to 1.
- **Upstash vectors:** they match Ollama's bge-m3 exactly (cosine 1.0000) for
  `"{title}\n{text}"`, so nothing is re-embedded. Their 471 English files are ordered by page id,
  so the first files hold the oldest, mostly core, articles. Newer topics (e.g. *Great Wall of
  China*) are not in files 000-004.
- **Caches:** the compose files start MariaDB with `--mhnsw-max-cache-size=1G` and
  `--innodb-buffer-pool-size=1G`. The 16 MB default vector cache makes search and loading much
  slower.
- **Limits:** one vector per article finds topics, not single facts in long articles (which is
  what the paragraphs fix), and 1% of the History of Finland articles were cut at 8,192 tokens
  when embedded. The category filter walks the category tree with a recursive CTE: exact, but
  slow for very large categories.
