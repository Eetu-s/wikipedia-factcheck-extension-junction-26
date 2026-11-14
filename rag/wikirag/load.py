"""Create the tables and load the demo's data into MariaDB (port of the demo's load.py --vectors).

    python -m wikirag.load               # tables, articles, categories and ready-made vectors
    python -m wikirag.load --no-vectors  # skip the vectors

Downloads the data files into data/wikirag/ the first time (~190 MB):
- articles and categories from the demo repository's data/ folder,
- the bge-m3 vectors from its data-v2 release.

Safe to run again: downloaded files are kept, rows already in a table are skipped.
"""
import argparse
import csv
import struct
import time
from pathlib import Path

import pyarrow.parquet as pq
import requests

from . import config
from .db import connect

REPO_RAW = "https://raw.githubusercontent.com/MariaDB/mariadb-vector-wikipedia-rag/main/data"
RELEASE = "https://github.com/MariaDB/mariadb-vector-wikipedia-rag/releases/download/data-v2"
LANGS = ("fi", "sv", "en")
BATCH = 200

FILES = {
    **{f"articles-{lang}.parquet": REPO_RAW for lang in LANGS},
    "category-links-fi.tsv": REPO_RAW,
    "article-categories-fi.tsv": REPO_RAW,
    "test-questions.tsv": REPO_RAW,
}
VECTOR_FILES = {f"vectors-{config.EMBED_MODEL}-{lang}.parquet": RELEASE for lang in LANGS}


def download(name, base, data_dir):
    path = data_dir / name
    if path.exists():
        return path
    print(f"Downloading {name} ...", flush=True)
    part = path.with_suffix(path.suffix + ".part")
    with requests.get(f"{base}/{name}", stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(part, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    part.rename(path)
    return path


def run_schema(cur):
    sql = (Path(__file__).parent / "schema.sql").read_text()
    lines = [line for line in sql.splitlines() if not line.lstrip().startswith("--")]
    for statement in "\n".join(lines).split(";"):
        if statement.strip():
            cur.execute(statement)


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m wikirag.load", description=__doc__.splitlines()[0])
    p.add_argument("--no-vectors", action="store_true", help="do not load the ready-made vectors")
    args = p.parse_args(argv)

    data_dir = config.DATA_DIR
    data_dir.mkdir(parents=True, exist_ok=True)
    files = dict(FILES) if args.no_vectors else {**FILES, **VECTOR_FILES}
    for name, base in files.items():
        download(name, base, data_dir)

    con = connect()
    cur = con.cursor()

    def insert(sql, rows):
        for i in range(0, len(rows), BATCH):
            cur.executemany(sql, rows[i:i + BATCH])
            con.commit()

    def count(table):
        cur.execute(f"SELECT lang, COUNT(*) FROM {table} GROUP BY lang")
        return dict(cur.fetchall())

    run_schema(cur)
    con.commit()

    # 1. Articles
    for lang in LANGS:
        path = data_dir / f"articles-{lang}.parquet"
        rows = [(r["lang"], r["page_id"], r["rev_id"], r["wikidata_id"], r["title"], r["url"],
                 r["date_modified"], r["text"]) for r in pq.read_table(path).to_pylist()]
        insert("""INSERT IGNORE INTO article
                  (lang, page_id, rev_id, wikidata_id, title, url, date_modified, text)
                  VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""", rows)
        print(f"{path.name}: {len(rows)} articles", flush=True)
    print("Articles in the table:", count("article"))

    # 2. Categories: the tree, and the Finnish articles' categories ...
    with open(data_dir / "category-links-fi.tsv", encoding="utf-8") as f:
        insert("INSERT IGNORE INTO category_link (parent, child) VALUES (%s, %s)",
               [(r["parent"], r["child"]) for r in csv.DictReader(f, delimiter="\t")])
    cur.execute("SELECT page_id FROM article WHERE lang = 'fi'")
    finnish = {page_id for (page_id,) in cur.fetchall()}
    with open(data_dir / "article-categories-fi.tsv", encoding="utf-8") as f:
        insert("INSERT IGNORE INTO article_category (lang, page_id, category) VALUES ('fi', %s, %s)",
               [(int(r["page_id"]), r["category"]) for r in csv.DictReader(f, delimiter="\t")
                if int(r["page_id"]) in finnish])
    # ... which the Swedish and English articles on the same topic inherit.
    cur.execute("""INSERT IGNORE INTO article_category (lang, page_id, category)
                   SELECT other.lang, other.page_id, c.category
                   FROM article_category c
                   JOIN article fi    ON fi.lang = 'fi' AND fi.page_id = c.page_id
                   JOIN article other ON other.wikidata_id = fi.wikidata_id AND other.lang <> 'fi'
                   WHERE c.lang = 'fi'""")
    con.commit()
    cur.execute("SELECT COUNT(*) FROM category_link")
    print(f"Category links: {cur.fetchone()[0]}. Article-category pairs:", count("article_category"))

    # 3. Ready-made vectors. MariaDB takes a VECTOR as raw bytes: float32, little-endian.
    if not args.no_vectors:
        for lang in LANGS:
            path = data_dir / f"vectors-{config.EMBED_MODEL}-{lang}.parquet"
            t = time.time()
            rows = [(r["lang"], r["page_id"], r["model"], r["truncated"],
                     struct.pack(f"<{len(r['embedding'])}f", *r["embedding"]))
                    for r in pq.read_table(path).to_pylist()]
            insert("""INSERT IGNORE INTO article_vector (lang, page_id, model, truncated, embedding)
                      VALUES (%s, %s, %s, %s, %s)""", rows)
            print(f"{path.name}: {len(rows)} vectors, {time.time() - t:.0f} s", flush=True)
        print("Vectors in the table:", count("article_vector"))
    con.close()


if __name__ == "__main__":
    main()
