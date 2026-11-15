import fcntl
import hmac
import json
import logging
import os
import tempfile
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.hashers import check_password
from django.db import transaction
from django.http import JsonResponse, StreamingHttpResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .checker import BATCH_DECISION_WORKERS, CheckerError, check, decide_or_error, retrieve_many
from .context import normalize_context
from .explainer import start_explanation, start_page_analysis
from .models import Explanation, PageCheck
from .accuracy import dataset, read_snapshot, statistics

# How long GET /api/factcheck/explanation/<id>/ waits for the explanation before answering
# "pending". Under 30 s, because Chrome can stop an extension's background script while a
# fetch takes longer than that.
EXPLANATION_WAIT_SECONDS = 25

# /api/factcheck-ratelimit/ accepts at most one request per this many seconds, from all clients.
RATELIMIT_SECONDS = 1.0
RATELIMIT_FILE = os.path.join(tempfile.gettempdir(), "factcheck-ratelimit")
logger = logging.getLogger(__name__)

# Repeated batches and analysis polls share one password. Keep only its successful
# keyed proof briefly, bound to the configured hash so password rotation takes effect at once.
_PASSWORD_CACHE_SECRET = os.urandom(32)
_PASSWORD_CACHE_SECONDS = 60
_verified_password = None


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

    if not authenticated_password(body.get("password")):
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
    if len(text) > 30000:
        return JsonResponse({"error": "'text' exceeds 30000 characters."}, status=400)
    fast_only = body.get("fast_only", False)
    if not isinstance(fast_only, bool):
        return JsonResponse({"error": "'fast_only' must be a boolean."}, status=400)
    sentence_id = body.get("sentence_id", "")
    if not isinstance(sentence_id, str) or len(sentence_id) > 200:
        return JsonResponse({"error": "'sentence_id' must be a string of at most 200 characters."}, status=400)
    try:
        context = normalize_context(body.get("context"))
    except ValueError as error:
        return JsonResponse({"error": str(error)}, status=400)

    try:
        result, source_articles = check(text, context) if fast_only or context else check(text)
    except CheckerError as e:
        if fast_only and e.retry_after is not None:
            response = JsonResponse({"error": "Fact check rate limited. Please retry later."}, status=429)
            response["Retry-After"] = str(e.retry_after)
            return response
        if fast_only:
            logger.warning("Fast page fact check failed: %s", e)
            return JsonResponse({"error": "Fact check is unavailable. Please retry."}, status=502)
        return JsonResponse({"error": f"Fact check failed: {e}"}, status=502)
    if fast_only:
        row = PageCheck.objects.create(
            sentence_id=sentence_id, original_text=text, context=context,
            decision=result.decision, confidence=result.confidence,
            sources=result.sources, evidence=source_articles,
        )
        return JsonResponse({**asdict(result), "check_id": str(row.pk), "sentence_id": sentence_id})
    result.explanation_id = start_explanation(text, result.decision, source_articles)
    return JsonResponse(asdict(result))


MAX_BATCH = 10


@csrf_exempt  # Called by the extension with a password, not a browser session.
@require_POST
def factcheck_batch(request):
    """
    Fast checks for several page sentences in one request (the page scan).

    Request:  {"password": str, "items": [{"text": str, "sentence_id": str, "context": {...}}, ...],
               "stream": bool}
    Response: {"results": [...]}, one per item in the same order, each either
      {"sentence_id", "decision", "confidence", "sources", "explanation_id": null, "check_id"}
      or {"sentence_id", "error": str, "status": 429 | 502, "retry_after": int | null}.
    With "stream": true, the response is NDJSON instead: one {"index": int, ...answer} line per
    item, in the order the decisions finish.

    Successful password verification is cached briefly. All retrieval queries are embedded
    in one call, Gemini decisions run in parallel, and stored checks are grouped in transactions.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Request body must be JSON."}, status=400)
    if not isinstance(body, dict):
        return JsonResponse({"error": "Request body must be a JSON object."}, status=400)
    if not authenticated_password(body.get("password")):
        return JsonResponse({"error": "Invalid password."}, status=401)

    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= MAX_BATCH:
        return JsonResponse({"error": f"'items' must be a list of 1 to {MAX_BATCH} sentences."}, status=400)
    items = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            return JsonResponse({"error": f"items[{index}] must be an object."}, status=400)
        text, sentence_id = raw.get("text"), raw.get("sentence_id", "")
        if not isinstance(text, str) or not text.strip() or len(text) > 30000:
            return JsonResponse({"error": f"items[{index}].text must be 1 to 30000 characters."}, status=400)
        if not isinstance(sentence_id, str) or len(sentence_id) > 200:
            return JsonResponse({"error": f"items[{index}].sentence_id must be at most 200 characters."}, status=400)
        try:
            context = normalize_context(raw.get("context"))
        except ValueError as error:
            return JsonResponse({"error": f"items[{index}]: {error}"}, status=400)
        items.append((text, sentence_id, context))

    stream = body.get("stream", False)
    if not isinstance(stream, bool):
        return JsonResponse({"error": "'stream' must be a boolean."}, status=400)

    # Retrieval (one embedding call, one database connection) runs before any response is sent,
    # so a failure that affects every sentence still gets a normal 502.
    try:
        article_lists = retrieve_many([(text, context) for text, _, context in items])
    except CheckerError as e:
        logger.warning("Batch page fact check failed: %s", e)
        return JsonResponse({"error": "Fact check is unavailable. Please retry."}, status=502)

    if stream:
        response = StreamingHttpResponse(stream_batch(items, article_lists), content_type="application/x-ndjson")
        response["Cache-Control"] = "no-store"
        response["X-Accel-Buffering"] = "no"  # nginx: pass each line on at once, don't buffer.
        return response

    with ThreadPoolExecutor(max_workers=min(BATCH_DECISION_WORKERS, len(items))) as pool:
        outcomes = list(pool.map(decide_or_error, [(text, context) for text, _, context in items], article_lists))
    answers = [batch_answer(item, outcome) for item, outcome in zip(items, outcomes)]
    with transaction.atomic():
        PageCheck.objects.bulk_create([row for _, row in answers if row])
    return JsonResponse({"results": [answer for answer, _ in answers]})


def stream_batch(items, article_lists):
    """NDJSON lines, one per sentence as soon as its Gemini decision finishes: {"index", ...answer}.

    Decisions that finish together are stored in one transaction, before their lines are sent,
    so a check_id always exists by the time the client can ask for its deeper analysis.
    """
    pool = ThreadPoolExecutor(max_workers=min(BATCH_DECISION_WORKERS, len(items)))
    try:
        futures = {
            pool.submit(decide_or_error, (text, context), articles): index
            for index, ((text, _, context), articles) in enumerate(zip(items, article_lists))
        }
        pending = set(futures)
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            finished = []
            for future in done:
                index = futures[future]
                try:
                    outcome = future.result()
                except Exception:  # A bug for one sentence must not cut off the others.
                    logger.exception("Page fact check crashed")
                    outcome = CheckerError("Internal error.")
                finished.append((index, *batch_answer(items[index], outcome)))
            with transaction.atomic():
                PageCheck.objects.bulk_create([row for _, _, row in finished if row])
            for index, answer, _ in sorted(finished, key=lambda entry: entry[0]):
                yield json.dumps({"index": index, **answer}) + "\n"
    finally:
        # The client may disconnect mid-stream: don't start decisions nobody will read.
        pool.shutdown(wait=False, cancel_futures=True)


def batch_answer(item, outcome):
    """One sentence's batch answer, and its unsaved PageCheck row (None for an error)."""
    text, sentence_id, context = item
    if isinstance(outcome, CheckerError):
        if outcome.retry_after is None:
            logger.warning("Page fact check failed: %s", outcome)
        return {
            "sentence_id": sentence_id,
            "error": "Fact check rate limited. Please retry later." if outcome.retry_after is not None
            else "Fact check is unavailable. Please retry.",
            "status": 429 if outcome.retry_after is not None else 502,
            "retry_after": outcome.retry_after,
        }, None
    result, source_articles = outcome
    row = PageCheck(
        sentence_id=sentence_id, original_text=text, context=context,
        decision=result.decision, confidence=result.confidence,
        sources=result.sources, evidence=source_articles,
    )
    return {**asdict(result), "check_id": str(row.pk), "sentence_id": sentence_id}, row


def authenticated_password(password):
    global _verified_password
    encoded = settings.FACTCHECK_PASSWORD_HASH
    if not isinstance(password, str) or not encoded:
        return False
    proof = hmac.digest(_PASSWORD_CACHE_SECRET, password.encode(), "sha256")
    cached = _verified_password
    if (cached is not None and cached[0] == encoded and time.monotonic() < cached[2]
            and hmac.compare_digest(proof, cached[1])):
        return True
    if not check_password(password, encoded):
        return False
    _verified_password = (encoded, proof, time.monotonic() + _PASSWORD_CACHE_SECONDS)
    return True


def page_check_response(row):
    payload = {"check_id": str(row.pk), "sentence_id": row.sentence_id,
               "decision": row.decision, "confidence": row.confidence,
               "sources": row.sources, "explanation_id": None, "status": "not_requested"}
    if row.explanation_id:
        explanation = row.explanation
        if (explanation.status == Explanation.Status.PENDING
                and explanation.created_at < timezone.now() - timedelta(minutes=3)):
            # A server restart can interrupt a daemon worker. Never leave a click pending forever.
            Explanation.objects.filter(pk=explanation.pk, status=Explanation.Status.PENDING).update(
                status=Explanation.Status.ERROR, error="Deeper analysis timed out.",
            )
            explanation.refresh_from_db()
        payload.update(explanation_id=str(explanation.pk), status=explanation.status)
        if explanation.status == Explanation.Status.DONE:
            payload.update(paragraphs=explanation.paragraphs, **explanation.analysis)
        elif explanation.status == Explanation.Status.ERROR:
            payload["error"] = explanation.error
    response = JsonResponse(payload)
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def analyze_page_check(request, check_id):
    """An explicit click attaches one explanation; duplicate clicks reuse it across workers."""
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "Request body must be JSON."}, status=400)
    if not isinstance(body, dict):
        return JsonResponse({"error": "Request body must be a JSON object."}, status=400)
    if not authenticated_password(body.get("password")):
        return JsonResponse({"error": "Invalid password."}, status=401)
    row = PageCheck.objects.filter(pk=check_id).first()
    if row is None:
        return JsonResponse({"error": "Unknown check id."}, status=404)
    start_page_analysis(row)
    row.refresh_from_db()
    return page_check_response(row)


@require_GET
def page_check(request, check_id):
    """Authenticated, non-blocking polling. Passwords never travel in URL query strings."""
    authorization = request.headers.get("Authorization", "")
    password = authorization[7:] if authorization.startswith("Bearer ") else None
    if not authenticated_password(password):
        return JsonResponse({"error": "Invalid password."}, status=401)
    row = PageCheck.objects.select_related("explanation").filter(pk=check_id).first()
    if row is None:
        return JsonResponse({"error": "Unknown check id."}, status=404)
    return page_check_response(row)


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
        # Page analyses require authentication even through this legacy UUID route.
        if PageCheck.objects.filter(explanation=row).exists():
            authorization = request.headers.get("Authorization", "")
            password = authorization[7:] if authorization.startswith("Bearer ") else None
            if not authenticated_password(password):
                return JsonResponse({"error": "Invalid password."}, status=401)
        if row.status == Explanation.Status.DONE:
            return JsonResponse({"status": row.status, "paragraphs": row.paragraphs, **row.analysis})
        if row.status == Explanation.Status.ERROR:
            return JsonResponse({"status": row.status, "error": row.error})
        if time.monotonic() >= deadline:
            return JsonResponse({"status": row.status})
        time.sleep(0.5)
