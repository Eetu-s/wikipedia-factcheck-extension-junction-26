"""Background explanations and factual corrections, fetched after the fast verdict.

The verdict is returned to the client right away. Deeper analysis runs
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
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

from .checker import Decision
from .models import Explanation, PageCheck

logger = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# Explanations are only needed for a minute or two after the verdict; older ones are deleted.
KEEP_FOR = timedelta(days=1)

PROMPT = """Claim: {claim}
Verdict: {verdict}

Which paragraph(s) in the Wikipedia articles below give this verdict for this claim?
Answer only with those paragraphs, nothing else. Copy each one word for word; if a paragraph is \
long, copy only the sentences that matter. Give one entry per selected article that supports or refutes \
the claim, and leave out articles that don't.

For a SUPPORTED verdict, identify the original claim's language and select relevant supporting
snippets in this order: first that language, then English, then any other language. Use only
the first tier that has a snippet supporting the claim among the supplied articles; omit
lower-priority languages when a higher-priority one has suitable evidence. Copy snippets
in their source language without translating them or inventing text.

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

    `articles` are the initial Wikipedia candidates for refuted claims, or selected sources
    for supported claims: [{"title", "url", "text"}, ...].
    NOT ENOUGH INFO has nothing to explain, so it gets no explanation.
    """
    if decision == Decision.NOT_ENOUGH_INFO or not articles:
        return None
    Explanation.objects.filter(created_at__lt=timezone.now() - KEEP_FOR, pagecheck__isnull=True).delete()
    explanation = Explanation.objects.create()
    threading.Thread(
        target=_run, args=(explanation.pk, claim, decision, articles), daemon=True
    ).start()
    return str(explanation.pk)


def start_page_analysis(row):
    """Atomically claim a stored check before dispatching its sole analysis worker.

    A conditional UPDATE also protects SQLite, where select_for_update is a no-op.
    Losing requests never launch a thread and return the winning explanation instead.
    """
    if row.explanation_id:
        return
    with transaction.atomic():
        explanation = Explanation.objects.create()
        claimed = PageCheck.objects.filter(pk=row.pk, explanation__isnull=True).update(
            explanation=explanation,
        )
        if not claimed:
            explanation.delete()
            return
        transaction.on_commit(lambda: launch_page_analysis(explanation.pk, row))


def launch_page_analysis(explanation_id, row):
    try:
        threading.Thread(target=_run_page, args=(explanation_id, row), daemon=True).start()
    except Exception:
        logger.exception("Could not dispatch page analysis %s", explanation_id)
        Explanation.objects.filter(pk=explanation_id).update(
            status=Explanation.Status.ERROR, error="Could not start deeper analysis.",
        )


def _run_page(explanation_id, row):
    close_old_connections()
    try:
        from .analysis import analyze_claim

        analysis = analyze_claim(row.original_text, row.evidence, row.decision, row.context)
        paragraphs = analysis.pop("paragraphs", [])
        Explanation.objects.filter(pk=explanation_id, status=Explanation.Status.PENDING).update(
            status=Explanation.Status.DONE, paragraphs=paragraphs, analysis=analysis,
        )
    except Exception as error:
        logger.exception("Page analysis %s failed", explanation_id)
        Explanation.objects.filter(pk=explanation_id).update(
            status=Explanation.Status.ERROR,
            error=str(error) if isinstance(error, ExplainerError) else "Internal error.",
        )
    finally:
        connection.close()


def _run(explanation_id, claim, decision, articles):
    close_old_connections()
    try:
        analysis = {}
        if decision == Decision.REFUTED:
            from .analysis import analyze_errors

            analysis = analyze_errors(claim, articles)
            paragraphs = [
                {"source": evidence["source"], "paragraph": evidence["quote"]}
                for error in analysis["errors"] for evidence in error["evidence"]
            ]
        else:
            paragraphs = ask_llm(claim, decision, articles)
        Explanation.objects.filter(pk=explanation_id).update(
            status=Explanation.Status.DONE, paragraphs=paragraphs, analysis=analysis
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
    numbered = "\n\n".join(
        f"[Article {i}] {a['title']} ({a['url']})\n{a['text']}" for i, a in enumerate(articles, 1)
    )
    answer = generate_json(
        PROMPT.format(claim=claim, verdict=decision.value, articles=numbered), RESPONSE_SCHEMA
    ).get("paragraphs")
    if not isinstance(answer, list):
        raise ExplainerError("Gemini's answer was not in the expected format.")
    by_number = {}
    for item in answer:
        if not isinstance(item, dict):
            continue
        number, paragraph = item.get("article"), str(item.get("paragraph", "")).strip()
        if type(number) is int and 1 <= number <= len(articles) and paragraph:
            by_number.setdefault(number, []).append(paragraph)
    return [
        {"source": articles[n - 1]["url"], "paragraph": "\n\n".join(by_number[n])}
        for n in sorted(by_number)
    ]


def generate_json(prompt: str, schema: dict, timeout: float = 60) -> dict:
    """Structured text generation shared by supported explanations and deeper analysis."""
    if not settings.GEMINI_API_KEY:
        raise ExplainerError("GEMINI_API_KEY is not set on the backend.")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
        },
    }
    request = urllib.request.Request(
        GEMINI_URL.format(model=settings.GEMINI_EXPLAIN_MODEL),
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": settings.GEMINI_API_KEY},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.load(response)
    except urllib.error.HTTPError as e:
        raise ExplainerError(f"Gemini returned HTTP {e.code}.") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise ExplainerError(f"Can't reach Gemini: {e}") from e

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        answer = json.loads(text)
        if not isinstance(answer, dict):
            raise ValueError("Expected an object.")
        return answer
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise ExplainerError("Gemini's answer was not in the expected format.") from e
