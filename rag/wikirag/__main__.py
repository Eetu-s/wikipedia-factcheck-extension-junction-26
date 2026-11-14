"""Search from the command line; prints the closest articles as JSON.

    python -m wikirag "Which peace treaty ended the Winter War?"
    python -m wikirag --lang fi "Suomi menetti Karjalan vuonna 1940"
    python -m wikirag --category "Suomen sisällissota" --excerpt "prison camps"
"""
import argparse
import sys
import time

from .db import connect
from .embedding import EmbeddingError
from .formatting import format_results
from .search import LANGS, semantic_search


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m wikirag", description=__doc__.splitlines()[0])
    p.add_argument("text", help="a question or a statement")
    p.add_argument("--lang", choices=LANGS, help="only articles in this language")
    p.add_argument("--category", help="only this Finnish category and its subcategories")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--excerpt", action="store_true", help="show an excerpt, not the whole text")
    args = p.parse_args(argv)

    con = connect()
    try:
        t = time.perf_counter()
        rows = semantic_search(con.cursor(), args.text, lang=args.lang,
                               category=args.category, limit=args.limit)
        took = (time.perf_counter() - t) * 1000
    except EmbeddingError as e:
        sys.exit(str(e))
    finally:
        con.close()
    sys.stdout.write(format_results(rows, query=args.text, lang=args.lang,
                                    category=args.category, full=not args.excerpt))
    print(f"\n({len(rows)} results in {took:.0f} ms, including embedding the text)", file=sys.stderr)


if __name__ == "__main__":
    main()
