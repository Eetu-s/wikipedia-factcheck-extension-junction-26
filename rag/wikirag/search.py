"""Semantic search over the Wikipedia articles (port of the demo's common.search()).

Every function takes a DB-API cursor with %s placeholders: a PyMySQL cursor from
wikirag.db.connect(), or Django's `connection.cursor()` when MariaDB is Django's database.
"""
import json

from . import config
from .embedding import embed

LANGS = ("fi", "sv", "en")

# The vector search stands alone in a subquery: ORDER BY distance LIMIT n on article_vector
# only. That is the shape in which MariaDB uses the vector index (~1-5 ms). Written as one
# flat JOIN, the demo measured ~22,000 rows read and ~50 ms for the same result.
VECTOR_SQL = """
SELECT a.lang, a.page_id, a.wikidata_id, a.title, a.url, v.distance
FROM (SELECT lang, page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS distance
      FROM article_vector
      {where}
      ORDER BY distance
      LIMIT %s) AS v
JOIN article a USING (lang, page_id)
ORDER BY v.distance"""

# A category and all its subcategories (recursive walk of the category tree).
# CAST: the first row fixes the column size, and subcategory names can be longer.
CATEGORY_TREE = """
WITH RECURSIVE cats AS (
  SELECT CAST(%s AS VARCHAR(255)) AS name
  UNION
  SELECT l.child FROM category_link l JOIN cats ON l.parent = cats.name)"""

IN_CATEGORY = """EXISTS (SELECT 1 FROM article_category c JOIN cats ON c.category = cats.name
              WHERE c.lang = a.lang AND c.page_id = a.page_id)"""

# Inside a category MariaDB starts from the category's articles and compares only those:
# exact, fast for small categories, slower for very big ones.
VECTOR_IN_CATEGORY_SQL = CATEGORY_TREE + """
SELECT a.lang, a.page_id, a.wikidata_id, a.title, a.url,
       VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(%s)) AS distance
FROM article_vector v
JOIN article a USING (lang, page_id)
WHERE """ + IN_CATEGORY + """
  {and_lang}
ORDER BY distance
LIMIT %s"""


def build_query(vector, lang=None, category=None, limit=10):
    """The SQL and parameters for one vector search."""
    if lang is not None and lang not in LANGS:
        raise ValueError(f"lang must be one of {', '.join(LANGS)}")
    vector_text = json.dumps(vector)
    if category:
        sql = VECTOR_IN_CATEGORY_SQL.format(and_lang="AND a.lang = %s" if lang else "")
        params = [category, vector_text] + ([lang] if lang else []) + [limit]
    else:
        sql = VECTOR_SQL.format(where="WHERE lang = %s" if lang else "")
        params = [vector_text] + ([lang] if lang else []) + [limit]
    return sql.strip(), params


def _dicts(cursor):
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def other_languages(cursor, rows):
    """Same topic in the other languages: {wikidata_id: [(lang, title, url), ...]}."""
    ids = sorted({r["wikidata_id"] for r in rows if r["wikidata_id"]})
    if not ids:
        return {}
    cursor.execute(
        "SELECT wikidata_id, lang, title, url FROM article WHERE wikidata_id IN "
        f"({', '.join(['%s'] * len(ids))}) ORDER BY lang",
        ids,
    )
    found = {}
    for wikidata_id, lang, title, url in cursor.fetchall():
        found.setdefault(wikidata_id, []).append((lang, title, url))
    return found


def article_texts(cursor, rows):
    """{(lang, page_id): text} for the given result rows, in one query."""
    if not rows:
        return {}
    keys = [(r["lang"], r["page_id"]) for r in rows]
    cursor.execute(
        "SELECT lang, page_id, text FROM article WHERE (lang, page_id) IN "
        f"({', '.join(['(%s, %s)'] * len(keys))})",
        [value for key in keys for value in key],
    )
    return {(lang, page_id): text for lang, page_id, text in cursor.fetchall()}


def semantic_search(cursor, text, lang=None, category=None, limit=10, vector=None,
                    with_text=True):
    """Embed `text` (a question or a statement) and return the closest articles.

    Each result is a dict: lang, page_id, wikidata_id, title, url, distance (smaller is
    closer), other_languages [(lang, title, url)], and text (unless with_text=False).
    Pass `vector` to skip embedding (the evaluation does, to time the two apart).
    """
    if vector is None:
        vector = embed(text)
    sql, params = build_query(vector, lang=lang, category=category, limit=limit)
    cursor.execute(f"SET SESSION mhnsw_ef_search = {int(config.EF_SEARCH)}")
    cursor.execute(sql, params)
    rows = _dicts(cursor)

    versions = other_languages(cursor, rows)
    texts = article_texts(cursor, rows) if with_text else {}
    for r in rows:
        r["distance"] = float(r["distance"])
        r["other_languages"] = [
            v for v in versions.get(r["wikidata_id"], []) if v[0] != r["lang"]
        ]
        if with_text:
            r["text"] = texts.get((r["lang"], r["page_id"]), "")
    return rows
