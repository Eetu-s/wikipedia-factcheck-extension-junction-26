"""Measure retrieval quality on the demo's 37 test questions (port of the demo's evaluate.py).

    python -m wikirag.evaluate            # hit@1/5/10 and MRR
    python -m wikirag.evaluate --misses   # also list questions whose answer is not in the top 5

A hit is the expected article in ANY language (same wikidata_id). The demo measured
hit@5 = 76% and hit@10 = 86% for vector search; matching that confirms this port.
"""
import argparse
import csv
import statistics
import time

from . import config
from .db import connect
from .embedding import embed
from .search import semantic_search


def summary(group):
    ranks = [q["rank"] for q in group]
    if not ranks:
        return "  0 |     - |     - |     - |    -"
    hit = lambda k: sum(1 for r in ranks if r and r <= k) / len(ranks)  # noqa: E731
    mrr = sum(1 / r for r in ranks if r) / len(ranks)
    return f"{len(group):>3} | {hit(1):5.0%} | {hit(5):5.0%} | {hit(10):5.0%} | {mrr:.2f}"


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m wikirag.evaluate")
    p.add_argument("--misses", action="store_true")
    p.add_argument("--questions", default=str(config.DATA_DIR / "test-questions.tsv"))
    args = p.parse_args(argv)

    con = connect()
    cur = con.cursor()
    with open(args.questions, encoding="utf-8") as f:
        questions = list(csv.DictReader(f, delimiter="\t"))
    for q in questions:
        cur.execute("SELECT wikidata_id, page_id FROM article WHERE lang = 'fi' AND title = %s",
                    (q["expected_fi_title"],))
        q["wikidata_id"], q["page_id"] = cur.fetchone()

    embed_ms, sql_ms = [], []
    for q in questions:
        t = time.perf_counter()
        vector = embed(q["question"])
        embed_ms.append((time.perf_counter() - t) * 1000)
        t = time.perf_counter()
        rows = semantic_search(cur, q["question"], limit=10, vector=vector, with_text=False)
        sql_ms.append((time.perf_counter() - t) * 1000)
        q["rank"] = next((i for i, r in enumerate(rows, 1)
                          if (q["wikidata_id"] and r["wikidata_id"] == q["wikidata_id"])
                          or (r["lang"] == "fi" and r["page_id"] == q["page_id"])), None)
        q["top"] = rows[0]["title"] if rows else "-"
    con.close()

    print(f"\nVector search — {len(questions)} questions\n")
    print("| Questions | n | hit@1 | hit@5 | hit@10 | MRR |")
    print("|---|---|---|---|---|---|")
    print(f"| all | {summary(questions)} |")
    for lang in ("en", "sv", "fi"):
        print(f"| in {lang} | {summary([q for q in questions if q['lang'] == lang])} |")
    print(f"| answer only in Finnish | "
          f"{summary([q for q in questions if q['article_exists_in'] == 'fi'])} |")
    print(f"\nEmbedding: median {statistics.median(embed_ms):.0f} ms. "
          f"Search (SQL + other languages): median {statistics.median(sql_ms):.1f} ms")
    if args.misses:
        print("\nNot in the top 5:")
        for q in questions:
            if not q["rank"] or q["rank"] > 5:
                print(f"- [{q['lang']}] {q['question']} → expected {q['expected_fi_title']}, "
                      f"rank {q['rank'] or '>10'}, top: {q['top']}")


if __name__ == "__main__":
    main()
