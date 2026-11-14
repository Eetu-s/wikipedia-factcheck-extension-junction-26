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


FAKE_ARTICLES = [
    {"title": "Eiffel Tower", "url": "https://en.wikipedia.org/wiki/Eiffel_Tower", "text": "Completed in 1889."},
    {"title": "Paris", "url": "https://en.wikipedia.org/wiki/Paris", "text": "Capital of France."},
]


def fake_gemini_response(choice, confidence, source_scores=(0.9, 0.1)):
    """What urlopen returns for a successful Gemini Decisions API call."""
    answers = {"verdict": {"type": "choice", "choice": choice, "confidence": confidence}}
    for i, score in enumerate(source_scores):
        answers[f"source_{i}"] = {"type": "noul", "noul": score, "confidence": 0.9}
    return io.BytesIO(json.dumps({"answers": answers}).encode())


@override_settings(FACTCHECK_PASSWORD_HASH=make_password("pw"), GEMINI_API_KEY="test-key")
@patch("factcheck.checker.search_wikipedia", return_value=FAKE_ARTICLES)
class FactCheckTests(TestCase):
    def post(self, text="The Eiffel Tower was completed in 1889.", password="pw"):
        return self.client.post(
            "/api/factcheck/", {"text": text, "password": password}, content_type="application/json"
        )

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_returns_gemini_decision(self, urlopen, search):
        urlopen.return_value = fake_gemini_response("supported", 0.97)
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "decision": "SUPPORTED",
                "confidence": 0.97,
                "sources": ["https://en.wikipedia.org/wiki/Eiffel_Tower"],
            },
        )

        request = urlopen.call_args.args[0]
        sent = json.loads(request.data)
        self.assertEqual(sent["model"], "gemini-decision-1")
        self.assertIn("The Eiffel Tower was completed in 1889.", sent["input"])
        self.assertIn("Capital of France.", sent["input"])
        self.assertEqual(set(sent["questions"]), {"verdict", "source_0", "source_1"})
        self.assertEqual(request.get_header("X-goog-api-key"), "test-key")

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_maps_all_choices(self, urlopen, search):
        for choice, decision in [("refuted", "REFUTED"), ("not_enough_info", "NOT ENOUGH INFO")]:
            urlopen.return_value = fake_gemini_response(choice, 0.8)
            self.assertEqual(self.post().json()["decision"], decision)

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_wrong_password_does_not_call_gemini(self, urlopen, search):
        self.assertEqual(self.post(password="wrong").status_code, 401)
        urlopen.assert_not_called()

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_gemini_error_returns_502(self, urlopen, search):
        urlopen.side_effect = urllib.error.HTTPError(
            "url", 429, "Too Many Requests", {}, io.BytesIO(b"quota exceeded")
        )
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("429", response.json()["error"])

    @override_settings(GEMINI_API_KEY="")
    def test_missing_gemini_key_returns_502(self, search):
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("GEMINI_API_KEY", response.json()["error"])
