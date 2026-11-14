import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from enum import StrEnum

import pymysql
from django.conf import settings
from wikirag import EmbeddingError, semantic_search
from wikirag.db import connect

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
        "You are a fact-checker. Using only the Wikipedia articles in the input, "
        "is the claim true or false?"
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


def check(text: str) -> tuple[FactCheckResult, list[dict]]:
    """The verdict, and the source articles behind it ([{"title", "url", "text"}, ...])."""
    articles = search_wikipedia(text)
    answers = ask_gemini(text, articles)
    verdict = answers["verdict"]
    decision = CHOICE_TO_DECISION[verdict["choice"]]
    sources = pick_sources(decision, articles, answers)
    result = FactCheckResult(decision=decision, confidence=verdict["confidence"], sources=sources)
    return result, [a for a in articles if a["url"] in sources]


def search_wikipedia(claim: str) -> list[dict]:
    """The closest Wikipedia articles from the RAG database: [{"title", "url", "text"}, ...]."""
    try:
        con = connect()
    except pymysql.MySQLError as e:
        raise CheckerError(f"Can't reach the RAG database: {e}") from e
    try:
        rows = semantic_search(con.cursor(), claim, limit=RAG_ARTICLES)
    except EmbeddingError as e:
        raise CheckerError(str(e)) from e
    except pymysql.MySQLError as e:
        raise CheckerError(f"RAG search failed: {e}") from e
    finally:
        con.close()
    # Cosine distance of each result (smaller is closer), useful for tuning the search.
    logger.debug(
        "RAG results for %r:%s",
        claim,
        "".join(f"\n  {r['distance']:.4f}  [{r['lang']}] {r['title']}" for r in rows),
    )
    return [
        {"title": r["title"], "url": r["url"], "text": (r["text"] or "")[:RAG_ARTICLE_CHARS]}
        for r in rows
    ]


def pick_sources(decision: Decision, articles: list[dict], answers: dict) -> list[str]:
    """URLs of the articles the model rated as relevant, most relevant first.

    The Decisions API can't cite, so each article gets its own yes/no question (see ask_gemini).
    A SUPPORTED or REFUTED decision always gets at least the most relevant article.
    """
    scored = sorted(
        ((answers[f"source_{i}"]["noul"], a["url"]) for i, a in enumerate(articles)), reverse=True
    )
    sources = [url for score, url in scored if score >= SOURCE_THRESHOLD]
    if not sources and scored and decision != Decision.NOT_ENOUGH_INFO:
        sources = [scored[0][1]]
    return sources


def build_input(claim: str, articles: list[dict]) -> str:
    parts = [f"Claim: {claim}\n\nWikipedia articles:"]
    for i, a in enumerate(articles, 1):
        parts.append(f"[Article {i}] {a['title']} ({a['url']})\n{a['text']}")
    return "\n\n".join(parts)


def source_question(number: int) -> dict:
    return {
        "type": "noul",
        "instructions": (
            f"Does Article {number} contain information that directly supports or contradicts "
            "the claim?"
        ),
    }


def ask_gemini(claim: str, articles: list[dict]) -> dict:
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
        "input": build_input(claim, articles),
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
        raise CheckerError(f"Gemini returned HTTP {e.code}: {e.read().decode(errors='replace')}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise CheckerError(f"Can't reach Gemini: {e}") from e
    # Answers come back under the same keys as the questions.
    return data["answers"]
