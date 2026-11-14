import fcntl
import json
import os
import tempfile
import time
from dataclasses import asdict

from django.conf import settings
from django.contrib.auth.hashers import check_password
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .checker import CheckerError, check
from .explainer import start_explanation
from .models import Explanation
from .accuracy import dataset, read_snapshot, statistics

# How long GET /api/factcheck/explanation/<id>/ waits for the explanation before answering
# "pending". Under 30 s, because Chrome can stop an extension's background script while a
# fetch takes longer than that.
EXPLANATION_WAIT_SECONDS = 25

# /api/factcheck-ratelimit/ accepts at most one request per this many seconds, from all clients.
RATELIMIT_SECONDS = 1.0
RATELIMIT_FILE = os.path.join(tempfile.gettempdir(), "factcheck-ratelimit")


@require_GET
def accuracy(request):
    """Read a stored evaluation. Deliberately no call to the checker or explainer."""
    snapshot = read_snapshot()
    _, rows = dataset()
    if snapshot is not None:
        rows = snapshot["rows"]
    return render(request, "factcheck/accuracy.html", {
        "run": snapshot, "rows": rows, "stats": statistics(rows),
    })


@require_GET
def accuracy_css(request):
    """Serve the report stylesheet from the same origin under the frontend's strict CSP."""
    return render(request, "factcheck/accuracy.css", content_type="text/css")


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


@csrf_exempt  # Called by the extension with a password, not a browser session.
@require_POST
def factcheck(request):
    """
    Request:  {"text": str, "password": str}
    Response: {"decision": "SUPPORTED" | "REFUTED" | "NOT ENOUGH INFO",
               "confidence": float (0.0–1.0),
               "sources": [str, ...],  # source URLs; for NOT ENOUGH INFO, all articles checked
               "explanation_id": str | null}  # null for NOT ENOUGH INFO

    The explanation is written in the background; fetch it from
    GET /api/factcheck/explanation/<explanation_id>/.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Request body must be JSON."}, status=400)
    if not isinstance(body, dict):
        return JsonResponse({"error": "Request body must be a JSON object."}, status=400)

    password = body.get("password")
    if not isinstance(password, str) or not settings.FACTCHECK_PASSWORD_HASH or not check_password(
        password, settings.FACTCHECK_PASSWORD_HASH
    ):
        return JsonResponse({"error": "Invalid password."}, status=401)

    return run_check(body)


@csrf_exempt  # Public: no password and no browser session.
@require_POST
def factcheck_ratelimit(request):
    """
    Same as /api/factcheck/, but needs no password. Instead, at most one request per second is
    accepted across all clients; the rest get HTTP 429.

    Request:  {"text": str}
    Response: the same as /api/factcheck/.
    """
    if not take_ratelimit_slot():
        response = JsonResponse({"error": "Too many requests. Try again in a second."}, status=429)
        response["Retry-After"] = "1"
        return response

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Request body must be JSON."}, status=400)
    if not isinstance(body, dict):
        return JsonResponse({"error": "Request body must be a JSON object."}, status=400)

    return run_check(body)


def take_ratelimit_slot() -> bool:
    """True if at least RATELIMIT_SECONDS have passed since the last accepted request.

    gunicorn runs several worker processes, so the time of the last accepted request lives in a
    file under an exclusive lock rather than in memory.
    """
    with open(RATELIMIT_FILE, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)  # Released when the file is closed.
        f.seek(0)
        try:
            last = float(f.read() or 0)
        except ValueError:
            last = 0.0
        now = time.time()
        if now - last < RATELIMIT_SECONDS:
            return False
        f.seek(0)
        f.truncate()
        f.write(str(now))
        return True


def run_check(body: dict) -> JsonResponse:
    """The fact check shared by both endpoints, after authentication or rate limiting."""
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'text' must be a non-empty string."}, status=400)

    try:
        result, source_articles = check(text)
    except CheckerError as e:
        return JsonResponse({"error": f"Fact check failed: {e}"}, status=502)
    result.explanation_id = start_explanation(text, result.decision, source_articles)
    return JsonResponse(asdict(result))


@require_GET
def explanation(request, explanation_id):
    """
    Waits up to EXPLANATION_WAIT_SECONDS for the explanation, then returns one of:
      {"status": "done", "paragraphs": [{"source": str, "paragraph": str}, ...],
       "errors": [...], "unverified_facts": [...], "incomplete": bool}  # analysis for refuted
      {"status": "pending"}                   # not ready yet: ask again
      {"status": "error", "error": str}
    The id is a random UUID that only the client who ran the check has, so no password is needed.
    """
    deadline = time.monotonic() + EXPLANATION_WAIT_SECONDS
    while True:
        row = Explanation.objects.filter(pk=explanation_id).first()
        if row is None:
            return JsonResponse({"error": "Unknown explanation id."}, status=404)
        if row.status == Explanation.Status.DONE:
            return JsonResponse({"status": row.status, "paragraphs": row.paragraphs, **row.analysis})
        if row.status == Explanation.Status.ERROR:
            return JsonResponse({"status": row.status, "error": row.error})
        if time.monotonic() >= deadline:
            return JsonResponse({"status": row.status})
        time.sleep(0.5)
