import json
from dataclasses import asdict

from django.conf import settings
from django.contrib.auth.hashers import check_password
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .checker import check


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
               "sources": [str, ...]}  # source URLs
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

    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'text' must be a non-empty string."}, status=400)

    return JsonResponse(asdict(check(text)))
