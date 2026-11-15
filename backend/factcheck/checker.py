import json
import logging
import math
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import StrEnum

import pymysql
from django.conf import settings
from wikirag import EmbeddingError, chunk_search, semantic_search
from wikirag.db import connect
from wikirag.embedding import embed_many
from wikirag.search import article_excerpt, article_paragraphs, article_texts

from .context import CONTEXT_RULES, context_input, retrieval_query

logger = logging.getLogger(__name__)


class Decision(StrEnum):
    SUPPORTED = "SUPPORTED"
    REFUTED = "REFUTED"
    NOT_ENOUGH_INFO = "NOT ENOUGH INFO"


@dataclass
class FactCheckResult:
    decision: Decision
    confidence: float  # 0.0–1.0
    sources: list[str] = field(default_factory=list)  # Source URLs backing the decision.
    # Id for fetching the explanation later (see explainer.py); None for NOT ENOUGH INFO.
    explanation_id: str | None = None


class CheckerError(Exception):
    """The fact check couldn't be done (e.g. Gemini is not configured or returned an error)."""

    def __init__(self, message, *, retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


# How many Wikipedia articles to give the model, and how much of each one.
RAG_ARTICLES = 3
RAG_ARTICLE_CHARS = 40_000

# An article counts as a source when the model rates it at least this likely to support or
# refute the claim.
SOURCE_THRESHOLD = 0.5

# Gemini Decision 1 picks one of a fixed set of options and returns the probability of each.
# It doesn't generate text, so it's fast (~200 ms) and cheap.
# Docs: https://aistudio.google.com/docs/decisions-api
GEMINI_MODEL = "gemini-decision-1"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"

VERDICT_QUESTION = {
    "type": "choice",
    "instructions": (
        "You are a fact-checker. " + CONTEXT_RULES
    ),
    "criteria": {
        "supported": "The articles show the claim is correct.",
        "refuted": "The articles show the claim is wrong.",
        "not_enough_info": "The articles don't say whether the claim is correct.",
    },
}
CHOICE_TO_DECISION = {
    "supported": Decision.SUPPORTED,
    "refuted": Decision.REFUTED,
    "not_enough_info": Decision.NOT_ENOUGH_INFO,
}


def check(text: str, context: dict | None = None) -> tuple[FactCheckResult, list[dict]]:
    """The verdict and its explanation articles ([{"title", "url", "text"}, ...])."""
    return decide(text, search_wikipedia(retrieval_query(text, context)), context)


# Gemini decision calls run in parallel within one batch; they mostly wait on the network.
BATCH_DECISION_WORKERS = 8


def check_many(items: list[tuple[str, dict | None]]) -> list:
    """check() for several (text, context) pairs, sharing the expensive steps.

    All retrieval queries are embedded in one Ollama call and searched over one database
    connection; the Gemini decisions then run in parallel. Returns one entry per item, in order:
    (FactCheckResult, articles), or the CheckerError for that item. Errors that affect every item
    (RAG database or Ollama down) are raised instead.
    """
    article_lists = retrieve_many(items)
    with ThreadPoolExecutor(max_workers=min(BATCH_DECISION_WORKERS, len(items))) as pool:
        return list(pool.map(decide_or_error, items, article_lists))


def retrieve_many(items: list[tuple[str, dict | None]]) -> list[list[dict]]:
    """The retrieval step of check_many(): articles for each (text, context) item."""
    return search_wikipedia_many([retrieval_query(text, context) for text, context in items])


def decide_or_error(item: tuple[str, dict | None], articles: list[dict]):
    """The decision step of check_many() for one item: (result, articles) or its CheckerError."""
    try:
        return decide(item[0], articles, item[1])
    except CheckerError as error:
        return error


def decide(text: str, articles: list[dict], context: dict | None) -> tuple[FactCheckResult, list[dict]]:
    """The Gemini verdict for `text`, given the articles retrieval found for it."""
    if not articles:
        return FactCheckResult(decision=Decision.NOT_ENOUGH_INFO, confidence=0.0), []
    answers = ask_gemini(text, articles, context) if context else ask_gemini(text, articles)
    try:
        verdict = answers["verdict"]
        decision = CHOICE_TO_DECISION[verdict["choice"]]
        confidence = verdict["confidence"]
        if (type(confidence) not in (int, float) or not math.isfinite(confidence)
                or not 0 <= confidence <= 1):
            raise ValueError("Invalid confidence.")
        for i in range(len(articles)):
            score = answers[f"source_{i}"]["noul"]
            if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid source score.")
        sources = pick_sources(decision, articles, answers)
    except (KeyError, TypeError, ValueError) as error:
        raise CheckerError("Gemini's decision was not in the expected format.") from error
    result = FactCheckResult(decision=decision, confidence=verdict["confidence"], sources=sources)
    # A refuted selection can contain several independent errors. Let the deeper analysis
    # see every candidate, while preserving the supported explanation's source filtering.
    return result, articles if context is not None or decision == Decision.REFUTED else [
        a for a in articles if a["url"] in sources
    ]


def search_wikipedia(claim: str) -> list[dict]:
    """The closest Wikipedia articles from the RAG database: [{"title", "url", "text"}, ...]."""
    return search_wikipedia_many([claim])[0]


def search_wikipedia_many(claims: list[str]) -> list[list[dict]]:
    """search_wikipedia() for several claims: one embedding call and one database connection.

    Each claim searches both whole-article vectors (article_vector: History of Finland in
    fi/sv/en) and paragraph vectors (chunk_vector: English Wikipedia), and the two rankings are
    fused (see fuse_rankings). Either table may be missing or empty. Evidence bodies are
    fetched only after fusion, once per unique article across the whole batch.
    """
    try:
        vectors = embed_many(claims)
    except EmbeddingError as e:
        raise CheckerError(str(e)) from e
    try:
        con = connect()
    except pymysql.MySQLError as e:
        raise CheckerError(f"Can't reach the RAG database: {e}") from e
    searches = [semantic_search, chunk_search]
    try:
        cursor = con.cursor()
        results = []
        for claim, vector in zip(claims, vectors):
            rankings = []
            for search in list(searches):
                try:
                    options = {"with_languages": False} if search is semantic_search else {}
                    rankings.append(search(cursor, claim, limit=RAG_ARTICLES, vector=vector,
                                           with_text=False, **options))
                except pymysql.ProgrammingError as e:
                    if e.args[0] != NO_SUCH_TABLE:
                        raise
                    searches.remove(search)  # Its data isn't loaded; skip it for the rest.
            results.append(fuse_rankings(rankings, RAG_ARTICLES))
        # Adjacent sentences tend to retrieve the same Wikipedia articles. Load each body
        # once for the batch, after distant candidates and losing rankings have been removed.
        selected = [row for rows in results for row in rows]
        texts = article_texts(cursor, [row for row in selected if "matched" not in row])
        paragraphs = article_paragraphs(cursor, [row for row in selected if "matched" in row])
        for row in selected:
            key = (row["lang"], row["page_id"])
            row["text"] = (article_excerpt(paragraphs.get(key, []), row["matched"], RAG_ARTICLE_CHARS)
                           if "matched" in row else texts.get(key, ""))
    except pymysql.MySQLError as e:
        raise CheckerError(f"RAG search failed: {e}") from e
    finally:
        con.close()
    for claim, rows in zip(claims, results):
        # Cosine distance of each result (smaller is closer), useful for tuning the search.
        logger.debug(
            "RAG results for %r:%s",
            claim,
            "".join(f"\n  {r['distance']:.4f}  [{r['lang']}] {r['title']}" for r in rows),
        )
    return [
        [{"title": r["title"], "url": r["url"], "text": (r["text"] or "")[:RAG_ARTICLE_CHARS]}
         for r in rows]
        for rows in results
    ]


NO_SUCH_TABLE = 1146  # MariaDB error: the table doesn't exist (its data isn't loaded).

# Results further than this (cosine distance) are left out. Unrelated articles measured
# ~0.50-0.55; the right article for a claim ~0.23-0.47. Tune with the accuracy benchmark.
MAX_DISTANCE = 0.5


def fuse_rankings(rankings: list[list[dict]], limit: int) -> list[dict]:
    """Merge rankings from different searches by rank, not by raw distance.

    Distances aren't comparable across the searches: one vector per whole article lies
    further from any claim than one per paragraph, so loosely related paragraphs (~0.40) would
    push out the right article (~0.47). Instead the rankings take turns, the one with the
    closest result first, skipping results beyond MAX_DISTANCE and articles already taken.
    """
    rankings = [[r for r in ranking if r["distance"] <= MAX_DISTANCE] for ranking in rankings]
    rankings = sorted((r for r in rankings if r), key=lambda ranking: ranking[0]["distance"])
    seen, result = set(), []
    for rank in range(max((len(r) for r in rankings), default=0)):
        for ranking in rankings:
            if rank < len(ranking):
                r = ranking[rank]
                key = (r["lang"], r["page_id"])
                if key not in seen:
                    seen.add(key)
                    result.append(r)
    return result[:limit]


def pick_sources(decision: Decision, articles: list[dict], answers: dict) -> list[str]:
    """URLs of the articles the model rated as relevant, most relevant first.

    The Decisions API can't cite, so each article gets its own yes/no question (see ask_gemini).
    A SUPPORTED or REFUTED decision always gets at least the most relevant article.
    NOT ENOUGH INFO gets every article the model checked, so the user can see what was read.
    """
    scored = sorted(
        ((answers[f"source_{i}"]["noul"], a["url"]) for i, a in enumerate(articles)), reverse=True
    )
    if decision == Decision.NOT_ENOUGH_INFO:
        return [url for score, url in scored]
    sources = [url for score, url in scored if score >= SOURCE_THRESHOLD]
    if not sources and scored:
        sources = [scored[0][1]]
    return sources


def build_input(claim: str, articles: list[dict], context: dict | None = None) -> str:
    parts = [f"TARGET SENTENCE\n{claim}", f"PAGE CONTEXT (not evidence)\n{context_input(context)}", "WIKIPEDIA EVIDENCE"]
    for i, a in enumerate(articles, 1):
        parts.append(f"[Article {i}] {a['title']} ({a['url']})\n{a['text']}")
    return "\n\n".join(parts)


def source_question(number: int) -> dict:
    return {
        "type": "noul",
        "instructions": (
            f"Does Article {number} contain information that directly supports or contradicts "
            "only the TARGET SENTENCE after disambiguation, using no PAGE CONTEXT as evidence?"
        ),
    }


def ask_gemini(claim: str, articles: list[dict], context: dict | None = None) -> dict:
    """Ask Gemini Decision 1 for a verdict, and which articles bear on it, in one call.

    Returns {"verdict": {"choice": "supported", "confidence": 0.97, ...},
             "source_0": {"noul": 0.92, ...}, "source_1": {...}, ...}.
    """
    if not settings.GEMINI_API_KEY:
        raise CheckerError("GEMINI_API_KEY is not set on the backend.")

    questions = {"verdict": VERDICT_QUESTION}
    for i in range(len(articles)):
        questions[f"source_{i}"] = source_question(i + 1)
    body = {
        "model": GEMINI_MODEL,
        "input": build_input(claim, articles, context),
        "questions": questions,
    }
    request = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": settings.GEMINI_API_KEY},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as e:
        retry_after = None
        if e.code == 429:
            try:
                retry_after = min(300, max(1, int((e.headers or {}).get("Retry-After", "1"))))
            except (ValueError, TypeError):
                retry_after = 1
        # Provider error bodies may contain credentials or request data. Keep them server-side.
        raise CheckerError(f"Gemini returned HTTP {e.code}.", retry_after=retry_after) from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise CheckerError(f"Can't reach Gemini: {e}") from e
    # Answers come back under the same keys as the questions.
    if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
        raise CheckerError("Gemini's decision was not in the expected format.")
    return data["answers"]
