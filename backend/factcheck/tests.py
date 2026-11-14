import io
import json
import urllib.error
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings


class HealthTests(TestCase):
    def test_health(self):
        response = self.client.get("/api/health/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


def fake_gemini_response(choice, confidence):
    """What urlopen returns for a successful Gemini Decisions API call."""
    body = {"answers": {"verdict": {"type": "choice", "choice": choice, "confidence": confidence}}}
    return io.BytesIO(json.dumps(body).encode())


@override_settings(FACTCHECK_PASSWORD_HASH=make_password("pw"), GEMINI_API_KEY="test-key")
class FactCheckTests(TestCase):
    def post(self, text="The Eiffel Tower was completed in 1889.", password="pw"):
        return self.client.post(
            "/api/factcheck/", {"text": text, "password": password}, content_type="application/json"
        )

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_returns_gemini_decision(self, urlopen):
        urlopen.return_value = fake_gemini_response("supported", 0.97)
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"decision": "SUPPORTED", "confidence": 0.97, "sources": []})

        request = urlopen.call_args.args[0]
        sent = json.loads(request.data)
        self.assertEqual(sent["model"], "gemini-decision-1")
        self.assertIn("The Eiffel Tower was completed in 1889.", sent["input"])
        self.assertEqual(request.get_header("X-goog-api-key"), "test-key")

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_maps_all_choices(self, urlopen):
        for choice, decision in [("refuted", "REFUTED"), ("not_enough_info", "NOT ENOUGH INFO")]:
            urlopen.return_value = fake_gemini_response(choice, 0.8)
            self.assertEqual(self.post().json()["decision"], decision)

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_wrong_password_does_not_call_gemini(self, urlopen):
        self.assertEqual(self.post(password="wrong").status_code, 401)
        urlopen.assert_not_called()

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_gemini_error_returns_502(self, urlopen):
        urlopen.side_effect = urllib.error.HTTPError(
            "url", 429, "Too Many Requests", {}, io.BytesIO(b"quota exceeded")
        )
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("429", response.json()["error"])

    @override_settings(GEMINI_API_KEY="")
    def test_missing_gemini_key_returns_502(self):
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("GEMINI_API_KEY", response.json()["error"])
