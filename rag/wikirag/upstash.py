"""Load English Wikipedia paragraphs with ready-made bge-m3 vectors into chunk/chunk_vector.

    python -m wikirag.upstash              # files 000-004: ~13k articles, 500k paragraphs
    python -m wikirag.upstash --files 0-7  # more
    python -m wikirag.upstash --files 3    # one file

Source: https://huggingface.co/datasets/Upstash/wikipedia-2024-06-bge-m3 (June 2024 dump,
paragraphs of at least 100 characters, embedded with bge-m3 with the title in front). English
has 471 files of 100,000 paragraphs (~440 MB each), ordered by page id, i.e. by when the
article was created. The first files hold the oldest articles, which are mostly core topics
(Aristotle, Abraham Lincoln, Koala, ...); later files are increasingly niche.

Each file is downloaded to data/wikirag/upstash/, loaded, then deleted (use --keep to keep it).
Safe to run again: finished files are recorded in loaded_file and skipped.
"""
import argparse
import struct
import time

import pyarrow.parquet as pq

from . import config
from .db import connect
from .load import download, run_schema

BASE = "https://huggingface.co/datasets/Upstash/wikipedia-2024-06-bge-m3/resolve/main/data"
LANG = "en"
FILE_COUNT = 471
BATCH = 500


def parse_files(spec):
    """'0-4' -> [0, 1, 2, 3, 4]; '3' -> [3]; '0-2,7' -> [0, 1, 2, 7]."""
    numbers = []
    for part in spec.split(","):
        first, _, last = part.partition("-")
        numbers.extend(range(int(first), int(last or first) + 1))
    if any(not 0 <= n < FILE_COUNT for n in numbers):
        raise ValueError(f"file numbers must be 0-{FILE_COUNT - 1}")
    return numbers


def parse_id(value):
    """Upstash ids are '<page_id>_<paragraph>', e.g. '864_37' -> (864, 37)."""
    page_id, seq = value.split("_")
    return int(page_id), int(seq)


def wiki_url(url):
    """Upstash writes spaces as %20; Wikipedia (and the article table) uses underscores."""
    return url.replace("%20", "_")


def rows_from(batch):
    """(chunk rows, chunk_vector rows) for one Arrow record batch."""
    chunks, vectors = [], []
    for r in batch.to_pylist():
        page_id, seq = parse_id(r["id"])
        chunks.append((LANG, page_id, seq, r["title"], wiki_url(r["url"]), r["text"]))
        # MariaDB takes a VECTOR as raw bytes: float32, little-endian.
        vectors.append((LANG, page_id, seq, struct.pack(f"<{len(r['embedding'])}f", *r["embedding"])))
    return chunks, vectors


def load_file(con, path, name):
    cur = con.cursor()
    total, started = 0, time.time()
    for batch in pq.ParquetFile(path).iter_batches(batch_size=BATCH):
        chunks, vectors = rows_from(batch)
        cur.executemany("""INSERT IGNORE INTO chunk (lang, page_id, seq, title, url, text)
                           VALUES (%s, %s, %s, %s, %s, %s)""", chunks)
        cur.executemany("""INSERT IGNORE INTO chunk_vector (lang, page_id, seq, embedding)
                           VALUES (%s, %s, %s, %s)""", vectors)
        con.commit()
        total += len(chunks)
        rate = total / (time.time() - started)
        print(f"\r{name}: {total:,} paragraphs, {rate:,.0f}/s", end="", flush=True)
    cur.execute("INSERT INTO loaded_file (name, row_count) VALUES (%s, %s)", (name, total))
    con.commit()
    print(f"\r{name}: {total:,} paragraphs in {time.time() - started:.0f} s", flush=True)


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m wikirag.upstash", description=__doc__.splitlines()[0])
    p.add_argument("--files", default="0-4", help="file numbers, e.g. 0-4 or 0-2,7 (default 0-4)")
    p.add_argument("--keep", action="store_true", help="keep the downloaded files")
    args = p.parse_args(argv)
    numbers = parse_files(args.files)

    data_dir = config.DATA_DIR / "upstash"
    data_dir.mkdir(parents=True, exist_ok=True)
    con = connect()
    cur = con.cursor()
    run_schema(cur)
    con.commit()
    cur.execute("SELECT name FROM loaded_file")
    done = {name for (name,) in cur.fetchall()}

    for n in numbers:
        name = f"{LANG}/{n:03d}.parquet"
        if name in done:
            print(f"{name}: already loaded")
            continue
        path = download(f"{n:03d}.parquet", f"{BASE}/{LANG}", data_dir)
        load_file(con, path, name)
        if not args.keep:
            path.unlink()

    cur.execute("SELECT COUNT(*), COUNT(DISTINCT page_id) FROM chunk")
    paragraphs, articles = cur.fetchone()
    print(f"chunk: {paragraphs:,} paragraphs from {articles:,} articles")
    con.close()


if __name__ == "__main__":
    main()
