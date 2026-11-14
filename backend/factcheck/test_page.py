"""Fast-only storage and explicit deep-analysis contracts (no external services)."""
import json
import io
import urllib.error
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.test import TestCase, SimpleTestCase, override_settings
from django.utils import timezone

from .analysis import analyze_claim
from .checker import CheckerError, Decision, FactCheckResult, build_input, check
from .explainer import start_page_analysis
from .models import Explanation, PageCheck


ARTICLES = [{"title": "Tower", "url": "https://en.wikipedia.org/wiki/Tower",
             "text": "The tower was completed in 1889."}]
CONTEXT = {"page_title": "Paris", "section_heading": "The tower",
           "paragraph": "The Eiffel Tower stands here. It was completed in 1889.",
           "previous": "The tower is in Paris.", "next": "It is a landmark.",
           "publication_date": "2026-11-14", "language": "en"}


@override_settings(FACTCHECK_PASSWORD_HASH=make_password("pw"), SECURE_SSL_REDIRECT=False)
class PageCheckAPITests(TestCase):
    def post(self, payload):
        return self.client.post("/api/factcheck/", payload, content_type="application/json")

    def saved(self, decision=Decision.SUPPORTED):
        return PageCheck.objects.create(
            original_text="It was completed in 1889.", sentence_id="s-1", context=CONTEXT,
            decision=decision, confidence=.95, sources=[ARTICLES[0]["url"]], evidence=ARTICLES,
        )

    @patch("factcheck.views.start_explanation")
    @patch("factcheck.views.check")
    def test_fast_only_stores_exact_wording_context_and_evidence_without_deep_work(self, checker, start):
        checker.return_value = (FactCheckResult(Decision.SUPPORTED, .95, [ARTICLES[0]["url"]]), ARTICLES)
        text = "  It was completed in 1889. 🗼"
        response = self.post({"text": text, "sentence_id": "s-1", "context": CONTEXT,
                              "fast_only": True, "password": "pw"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["sentence_id"], "s-1")
        self.assertIsNone(body["explanation_id"])
        row = PageCheck.objects.get(pk=body["check_id"])
        self.assertEqual(row.original_text, text)
        self.assertEqual(row.context, CONTEXT)
        self.assertEqual(row.evidence, ARTICLES)
        self.assertIsNone(row.explanation_id)
        checker.assert_called_once_with(text, CONTEXT)
        start.assert_not_called()
        self.assertFalse(Explanation.objects.exists())

    @patch("factcheck.views.check")
    def test_auth_and_context_validation_happen_before_retrieval(self, checker):
        for payload, status in [
            ({"text": "Claim.", "password": "bad", "fast_only": True}, 401),
            ({"text": "Claim.", "password": "pw", "context": []}, 400),
            ({"text": "Claim.", "password": "pw", "context": {"paragraph": []}}, 400),
            ({"text": "Claim.", "password": "pw", "fast_only": "true"}, 400),
            ({"text": "Claim.", "password": "pw", "sentence_id": []}, 400),
        ]:
            self.assertEqual(self.post(payload).status_code, status)
        checker.assert_not_called()

    @patch("factcheck.explainer.launch_page_analysis")
    @patch("factcheck.views.check")
    def test_click_is_idempotent_and_reuses_saved_evidence_for_every_verdict(self, checker, launch):
        for decision in Decision:
            row = self.saved(decision)
            path = f"/api/factcheck/check/{row.pk}/analyze/"
            with self.captureOnCommitCallbacks(execute=True):
                first = self.client.post(path, {"password": "pw"}, content_type="application/json")
                second = self.client.post(path, {"password": "pw"}, content_type="application/json")
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()["status"], "pending")
            self.assertEqual(first.json()["explanation_id"], second.json()["explanation_id"])
            row.refresh_from_db()
            self.assertEqual(launch.call_args.args[0], row.explanation_id)
            sent_row = launch.call_args.args[1]
            self.assertEqual(sent_row.original_text, row.original_text)
            self.assertEqual(sent_row.evidence, ARTICLES)
            self.assertEqual(sent_row.context, CONTEXT)
        self.assertEqual(launch.call_count, 3)
        self.assertEqual(Explanation.objects.count(), 3)
        checker.assert_not_called()

    @patch("factcheck.explainer.launch_page_analysis")
    def test_done_analysis_is_reused_and_polling_is_authenticated(self, launch):
        row = self.saved(Decision.NOT_ENOUGH_INFO)
        row.explanation = Explanation.objects.create(
            status=Explanation.Status.DONE, paragraphs=[],
            analysis={"explanation": "The evidence is insufficient.", "errors": [],
                      "unverified_facts": [], "incomplete": True},
        )
        row.save()
        path = f"/api/factcheck/check/{row.pk}/"
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.get(path, HTTP_AUTHORIZATION="Bearer wrong").status_code, 401)
        response = self.client.get(path, HTTP_AUTHORIZATION="Bearer pw")
        self.assertEqual(response.json()["status"], "done")
        self.assertTrue(response.json()["incomplete"])
        response = self.client.post(path + "analyze/", {"password": "pw"}, content_type="application/json")
        self.assertEqual(response.json()["status"], "done")
        launch.assert_not_called()
        # The legacy polling path cannot bypass authentication for page results.
        self.assertEqual(self.client.get(f"/api/factcheck/explanation/{row.explanation_id}/").status_code, 401)

    def test_polling_never_starts_analysis_and_bad_click_does_not_start_it(self):
        row = self.saved()
        path = f"/api/factcheck/check/{row.pk}/"
        self.assertEqual(self.client.get(path, HTTP_AUTHORIZATION="Bearer pw").json()["status"], "not_requested")
        self.assertEqual(self.client.post(path + "analyze/", {"password": "bad"}, content_type="application/json").status_code, 401)
        self.assertFalse(Explanation.objects.exists())

    @patch("factcheck.views.check")
    def test_upstream_rate_limits_only_use_429_for_fast_only(self, checker):
        checker.side_effect = CheckerError("Gemini returned HTTP 429.", retry_after=7)
        response = self.post({"text": "Claim.", "password": "pw", "fast_only": True})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "7")
        self.assertEqual(self.post({"text": "Claim.", "password": "pw"}).status_code, 502)
        self.assertFalse(PageCheck.objects.exists())

    @patch("factcheck.explainer.launch_page_analysis")
    def test_two_stale_row_objects_can_only_claim_one_analysis(self, launch):
        row = self.saved()
        stale_row = PageCheck.objects.get(pk=row.pk)
        with self.captureOnCommitCallbacks(execute=True):
            start_page_analysis(row)
            start_page_analysis(stale_row)
        launch.assert_called_once()
        self.assertEqual(Explanation.objects.count(), 1)

    def test_interrupted_worker_has_terminal_timeout_and_does_not_restart(self):
        row = self.saved()
        row.explanation = Explanation.objects.create()
        row.save()
        Explanation.objects.filter(pk=row.explanation_id).update(
            created_at=timezone.now() - timedelta(minutes=4),
        )
        path = f"/api/factcheck/check/{row.pk}/"
        response = self.client.get(path, HTTP_AUTHORIZATION="Bearer pw")
        self.assertEqual(response.json()["status"], "error")
        self.assertIn("timed out", response.json()["error"])
        response = self.client.post(path + "analyze/", {"password": "pw"}, content_type="application/json")
        self.assertEqual(response.json()["status"], "error")
        self.assertEqual(Explanation.objects.count(), 1)


class ContextAndAnalysisTests(SimpleTestCase):
    @patch("factcheck.checker.ask_gemini")
    @patch("factcheck.checker.search_wikipedia", return_value=ARTICLES)
    def test_retrieval_includes_local_context_and_retains_gray_candidates(self, search, model):
        model.return_value = {"verdict": {"choice": "not_enough_info", "confidence": .8},
                              "source_0": {"noul": .1}}
        result, evidence = check("It was completed in 1889.", CONTEXT)
        self.assertEqual(result.decision, Decision.NOT_ENOUGH_INFO)
        self.assertEqual(evidence, ARTICLES)
        query = search.call_args.args[0]
        self.assertTrue(query.startswith("It was completed in 1889."))
        # Retrieval keeps only what names the subject; the paragraph goes to the model instead.
        for kept in ("previous", "section_heading", "page_title"):
            self.assertIn(CONTEXT[kept], query)
        self.assertNotIn(CONTEXT["paragraph"], query)
        self.assertNotIn(CONTEXT["next"], query)
        prompt = build_input("It was completed in 1889.", ARTICLES, CONTEXT)
        self.assertIn("TARGET SENTENCE", prompt)
        self.assertIn("PAGE CONTEXT (not evidence)", prompt)
        self.assertIn("WIKIPEDIA EVIDENCE", prompt)

    @patch("factcheck.analysis.generate_json")
    def test_unicode_offsets_and_repeated_phrases_are_verified_without_relocating(self, model):
        claim = "🗼 1900, then 1900."
        start = claim.rindex("1900")
        error = {"original_text": "1900", "start": start, "end": start + 4,
                 "explanation": "It was 1889.", "correction": "1889",
                 "evidence": [{"article": 1, "quote": ARTICLES[0]["text"]}]}
        model.return_value = {"explanation": "The date is wrong.", "errors": [error],
                              "paragraphs": [], "unverified_facts": [], "incomplete": False}
        result = analyze_claim(claim, ARTICLES, "REFUTED", CONTEXT)
        self.assertEqual(result["errors"][0]["start"], start)
        self.assertEqual(result["errors"][0]["original_text"], claim[start:start + 4])
        # A UTF-16 offset would be wrong after the emoji; reject rather than relocate it.
        error["start"] += 1
        error["end"] += 1
        result = analyze_claim(claim, ARTICLES, "REFUTED", CONTEXT)
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["incomplete"])

    @patch("factcheck.analysis.generate_json")
    def test_supported_and_uncertain_targets_receive_deep_explanations(self, model):
        model.return_value = {"explanation": "The article gives the completion date.", "errors": [],
                              "paragraphs": [{"article": 1, "quote": ARTICLES[0]["text"]}],
                              "unverified_facts": [], "incomplete": False}
        for verdict in ("SUPPORTED", "NOT ENOUGH INFO"):
            result = analyze_claim("It was completed in 1889.", ARTICLES, verdict, CONTEXT)
            self.assertEqual(result["explanation"], model.return_value["explanation"])
            self.assertEqual(result["paragraphs"][0]["source"], ARTICLES[0]["url"])
            prompt = model.call_args.args[0]
            self.assertIn("PAGE CONTEXT (disambiguation only, never evidence)", prompt)
            self.assertIn(verdict, prompt)

    @patch("factcheck.analysis.generate_json")
    def test_invented_quotes_do_not_become_corrections(self, model):
        model.return_value = {"explanation": "Uncertain.", "paragraphs": [], "errors": [
            {"original_text": "1900", "start": 0, "end": 4, "explanation": "Wrong.",
             "correction": "1889", "evidence": [{"article": 1, "quote": "An invented quote."}]}
        ], "unverified_facts": [], "incomplete": False}
        result = analyze_claim("1900", ARTICLES, "REFUTED")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["incomplete"])

    @patch("factcheck.analysis.generate_json")
    def test_no_evidence_explains_gray_in_finnish_without_model_work(self, model):
        result = analyze_claim("Se rakennettiin vuonna 1900.", [], "NOT ENOUGH INFO", {"language": "fi"})
        self.assertIn("näyttöä", result["explanation"])
        self.assertTrue(result["incomplete"])
        self.assertEqual(result["errors"], [])
        model.assert_not_called()

    @override_settings(GEMINI_API_KEY="test-key")
    @patch("factcheck.checker.urllib.request.urlopen")
    @patch("factcheck.checker.search_wikipedia", return_value=ARTICLES)
    def test_provider_429_has_bounded_retry_delay_and_no_error_body(self, search, urlopen):
        urlopen.side_effect = urllib.error.HTTPError(
            "url", 429, "quota", {"Retry-After": "9999"}, io.BytesIO(b"secret provider details"),
        )
        with self.assertRaises(CheckerError) as raised:
            check("Target.", CONTEXT)
        self.assertEqual(raised.exception.retry_after, 300)
        self.assertNotIn("secret", str(raised.exception))

    @patch("factcheck.checker.ask_gemini")
    @patch("factcheck.checker.search_wikipedia", return_value=ARTICLES)
    def test_malformed_model_answer_becomes_checker_error(self, search, model):
        model.return_value = {"verdict": {"choice": "supported", "confidence": float("nan")}}
        with self.assertRaises(CheckerError):
            check("Target.", CONTEXT)
