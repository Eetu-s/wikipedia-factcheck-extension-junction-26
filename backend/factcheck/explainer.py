"""Explanations: which paragraphs of the source articles give the verdict.

The verdict is returned to the client right away. The explanation needs one LLM call, which runs
in a background thread and stores its answer in an Explanation row. The client then fetches it
from /api/factcheck/explanation/<id>/.
"""
import json
import logging
import threading
import urllib.error
import urllib.request
from datetime import timedelta

from django.conf import settings
from django.db import close_old_connections, connection
from django.utils import timezone

from .checker import Decision
from .models import Explanation

logger = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# Explanations are only needed for a minute or two after the verdict; older ones are deleted.
KEEP_FOR = timedelta(days=1)

PROMPT = """Claim: {claim}
Verdict: {verdict}

Which paragraph(s) in the Wikipedia articles below give this verdict for this claim?
Answer only with those paragraphs, nothing else. Copy each one word for word; if a paragraph is \
long, copy only the sentences that matter. Give one entry per article that supports or refutes \
the claim, and leave out articles that don't.

{articles}"""

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "paragraphs": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "article": {"type": "INTEGER", "description": "The article's number."},
                    "paragraph": {"type": "STRING"},
                },
                "required": ["article", "paragraph"],
            },
        }
    },
    "required": ["paragraphs"],
}


class ExplainerError(Exception):
    pass


def start_explanation(claim: str, decision: Decision, articles: list[dict]) -> str | None:
    """Start explaining the verdict in the background. Returns the explanation id, or None.

    `articles` are the verdict's sources: [{"title", "url", "text"}, ...].
    NOT ENOUGH INFO has nothing to explain, so it gets no explanation.
    """
    if decision == Decision.NOT_ENOUGH_INFO or not articles:
        return None
    Explanation.objects.filter(created_at__lt=timezone.now() - KEEP_FOR).delete()
    explanation = Explanation.objects.create()
    threading.Thread(
        target=_run, args=(explanation.pk, claim, decision, articles), daemon=True
    ).start()
    return str(explanation.pk)


def _run(explanation_id, claim, decision, articles):
    close_old_connections()
    try:
        paragraphs = ask_llm(claim, decision, articles)
        Explanation.objects.filter(pk=explanation_id).update(
            status=Explanation.Status.DONE, paragraphs=paragraphs
        )
    except Exception as e:  # The thread must always leave the row finished, never pending.
        logger.exception("Explanation %s failed", explanation_id)
        Explanation.objects.filter(pk=explanation_id).update(
            status=Explanation.Status.ERROR, error=str(e) if isinstance(e, ExplainerError) else "Internal error."
        )
    finally:
        connection.close()  # This thread's own DB connection.


def ask_llm(claim: str, decision: Decision, articles: list[dict]) -> list[dict]:
    """One Gemini call. Returns [{"source": url, "paragraph": text}, ...] in article order."""
    if not settings.GEMINI_API_KEY:
        raise ExplainerError("GEMINI_API_KEY is not set on the backend.")

    numbered = "\n\n".join(
        f"[Article {i}] {a['title']} ({a['url']})\n{a['text']}" for i, a in enumerate(articles, 1)
    )
    body = {
        "contents": [
            {"parts": [{"text": PROMPT.format(claim=claim, verdict=decision.value, articles=numbered)}]}
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    request = urllib.request.Request(
        GEMINI_URL.format(model=settings.GEMINI_EXPLAIN_MODEL),
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": settings.GEMINI_API_KEY},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
    except urllib.error.HTTPError as e:
        raise ExplainerError(f"Gemini returned HTTP {e.code}: {e.read().decode(errors='replace')}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise ExplainerError(f"Can't reach Gemini: {e}") from e

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        answer = json.loads(text)["paragraphs"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
        raise ExplainerError("Gemini's answer was not in the expected format.") from e

    by_number = {}
    for item in answer:
        number, paragraph = item.get("article"), str(item.get("paragraph", "")).strip()
        if isinstance(number, int) and 1 <= number <= len(articles) and paragraph:
            by_number.setdefault(number, []).append(paragraph)
    return [
        {"source": articles[n - 1]["url"], "paragraph": "\n\n".join(by_number[n])}
        for n in sorted(by_number)
    ]
