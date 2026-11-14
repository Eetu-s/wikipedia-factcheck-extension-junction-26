"""Render search results as JSON."""
import json


def _excerpt(text, limit):
    """(text, truncated). Cuts at a word boundary when one is reasonably close."""
    text = text.strip()
    if limit is None or len(text) <= limit:
        return text, False
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.8:
        cut = cut[:space]
    return cut.rstrip(), True


def results_to_dict(rows, query=None, lang=None, category=None, full=True,
                    excerpt_chars=1500):
    """The closest articles, ranked, as a JSON-serializable dict."""
    results = []
    for rank, r in enumerate(rows, 1):
        item = {
            "rank": rank,
            "title": r["title"],
            "lang": r["lang"],
            "page_id": r["page_id"],
            "wikidata_id": r["wikidata_id"],
            "url": r["url"],
            "distance": r["distance"],
            "other_languages": [
                {"lang": l, "title": title, "url": url}
                for l, title, url in (r.get("other_languages") or [])
            ],
        }
        if "text" in r:
            item["text"], item["truncated"] = _excerpt(
                r["text"] or "", None if full else excerpt_chars)
        results.append(item)
    return {
        "query": query,
        "lang": lang,
        "category": category,
        "count": len(results),
        "results": results,
    }


def format_results(rows, query=None, lang=None, category=None, full=True,
                   excerpt_chars=1500):
    """results_to_dict() serialized as indented JSON (non-ASCII kept readable)."""
    data = results_to_dict(rows, query=query, lang=lang, category=category,
                           full=full, excerpt_chars=excerpt_chars)
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"
