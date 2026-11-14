import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from enum import StrEnum

from django.conf import settings


class Decision(StrEnum):
    SUPPORTED = "SUPPORTED"
    REFUTED = "REFUTED"
    NOT_ENOUGH_INFO = "NOT ENOUGH INFO"


@dataclass
class FactCheckResult:
    decision: Decision
    confidence: float  # 0.0–1.0
    sources: list[str] = field(default_factory=list)  # Source URLs backing the decision.


class CheckerError(Exception):
    """The fact check couldn't be done (e.g. Gemini is not configured or returned an error)."""


# Gemini Decision 1 picks one of a fixed set of options and returns the probability of each.
# It doesn't generate text, so it's fast (~200 ms) and cheap.
# Docs: https://aistudio.google.com/docs/decisions-api
GEMINI_MODEL = "gemini-decision-1"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"

VERDICT_QUESTION = {
    "type": "choice",
    "instructions": "You are a fact-checker. Is the claim in the input true or false?",
    "criteria": {
        "supported": "The claim is factually correct.",
        "refuted": "The claim is factually wrong.",
        "not_enough_info": "The claim can't be checked with public knowledge.",
    },
}
CHOICE_TO_DECISION = {
    "supported": Decision.SUPPORTED,
    "refuted": Decision.REFUTED,
    "not_enough_info": Decision.NOT_ENOUGH_INFO,
}


def check(text: str) -> FactCheckResult:
    # TODO: give the model Wikipedia passages from the RAG search and return them as sources.
    # For now the model decides from its own knowledge, so there are no sources.
    answer = ask_gemini(text)
    return FactCheckResult(
        decision=CHOICE_TO_DECISION[answer["choice"]],
        confidence=answer["confidence"],
        sources=[],
    )


def ask_gemini(claim: str) -> dict:
    """Ask Gemini Decision 1 for a verdict on the claim.

    Returns e.g. {"choice": "supported", "probabilities": {...}, "confidence": 0.97}.
    """
    if not settings.GEMINI_API_KEY:
        raise CheckerError("GEMINI_API_KEY is not set on the backend.")

    body = {
        "model": GEMINI_MODEL,
        "input": "Claim: " + claim,
        "questions": {"verdict": VERDICT_QUESTION},
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
    # The answer comes back under the same key as the question ("verdict").
    return data["answers"]["verdict"]
