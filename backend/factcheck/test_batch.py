"""Progressive page checks, with all network/model work mocked."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings

from . import views
from .checker import CheckerError, Decision, FactCheckResult
from .models import PageCheck


ARTICLES = [{"title": "Tower", "url": "https://en.wikipedia.org/wiki/Tower", "text": "Built in 1889."}]
RESULT = FactCheckResult(Decision.SUPPORTED, .9, [ARTICLES[0]["url"]])


@override_settings(FACTCHECK_PASSWORD_HASH=make_password("pw"), SECURE_SSL_REDIRECT=False)
class BatchCheckTests(TestCase):
    def post(self, count=4, **extra):
        return self.client.post("/api/factcheck/batch/", {
            "password": "pw", "stream": True,
            "items": [{"text": f"Claim {index}.", "sentence_id": f"s-{index}"} for index in range(count)],
            **extra,
        }, content_type="application/json")

    @patch("factcheck.views.decide_or_error", return_value=(RESULT, ARTICLES))
    @patch("factcheck.views.retrieve_many", return_value=[ARTICLES, ARTICLES])
    def test_stream_starts_without_waiting_for_retrieval_and_yields_saved_checks(self, retrieve, decide):
        response = self.post(count=2)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.streaming)
        retrieve.assert_not_called()
        self.assertEqual(response["X-Accel-Buffering"], "no")
        self.assertIn("no-transform", response["Cache-Control"])
        for line in response.streaming_content:
            answer = json.loads(line)
            self.assertEqual(answer["sentence_id"], f"s-{answer['index']}")
            self.assertTrue(PageCheck.objects.filter(pk=answer["check_id"]).exists())
        self.assertEqual(PageCheck.objects.count(), 2)
        self.assertEqual(decide.call_count, 2)

    def test_ready_sentence_does_not_wait_for_earlier_retrieval_or_a_slow_model(self):
        release_retrieval, release_model = Event(), Event()
        retrieval_started, model_started = Event(), Event()
        retrieval_finished, model_finished = Event(), Event()

        def retrieve(items):
            if items[0][0] == "Claim 0.":
                retrieval_started.set()
                release_retrieval.wait(3)
                retrieval_finished.set()
            return [ARTICLES for _ in items]

        def decide(item, articles):
            if item[0] == "Claim 3.":
                model_started.set()
                release_model.wait(3)
                model_finished.set()
            return RESULT, articles

        with patch("factcheck.views.retrieve_many", side_effect=retrieve), \
                patch("factcheck.views.decide_or_error", side_effect=decide):
            response = self.post()
            try:
                first = json.loads(next(iter(response.streaming_content)))
                self.assertEqual(first["index"], 2)
                self.assertTrue(retrieval_started.wait(1))
                self.assertTrue(model_started.wait(1))
                self.assertFalse(retrieval_finished.is_set(), "an earlier retrieval must not gate ready results")
                self.assertFalse(model_finished.is_set(), "a slow model must not gate ready results")
                self.assertTrue(PageCheck.objects.filter(pk=first["check_id"]).exists())
                response.close()
            finally:
                release_retrieval.set()
                release_model.set()
                retrieval_finished.wait(1)
                model_finished.wait(1)
                response.close()
        self.assertEqual(PageCheck.objects.count(), 1, "closing a stream must not store its unfinished results")

    def test_stream_close_cancels_queued_retrieval_without_shutting_down_shared_pools(self):
        release, second_started = Event(), Event()
        calls = []

        def retrieve(items):
            calls.append(items[0][0])
            if items[0][0] == "Claim 2.":
                second_started.set()
                release.wait(3)
            return [ARTICLES for _ in items]

        with ThreadPoolExecutor(max_workers=1) as retrieval_pool, \
                ThreadPoolExecutor(max_workers=1) as decision_pool, \
                patch.object(views, "stream_retrieval_pool", retrieval_pool), \
                patch.object(views, "stream_decision_pool", decision_pool), \
                patch("factcheck.views.retrieve_many", side_effect=retrieve), \
                patch("factcheck.views.decide_or_error", return_value=(RESULT, ARTICLES)):
            response = self.post(count=6)
            try:
                next(iter(response.streaming_content))
                self.assertTrue(second_started.wait(1))
                response.close()
            finally:
                release.set()
                response.close()
            # A different scan can still submit work to the shared pools.
            self.assertEqual(retrieval_pool.submit(lambda: "alive").result(timeout=1), "alive")
            self.assertEqual(decision_pool.submit(lambda: "alive").result(timeout=1), "alive")
        self.assertNotIn("Claim 4.", calls, "queued retrieval should be cancelled on disconnect")

    def test_retrieval_and_model_errors_are_independent_and_sanitized(self):
        def retrieve(items):
            if items[0][0] == "Claim 0.":
                raise CheckerError("private provider response", retry_after=7)
            return [ARTICLES for _ in items]

        def decide(item, articles):
            return CheckerError("private model response") if item[0] == "Claim 2." else (RESULT, articles)

        with patch("factcheck.views.retrieve_many", side_effect=retrieve), \
                patch("factcheck.views.decide_or_error", side_effect=decide):
            answers = {answer["index"]: answer for answer in map(json.loads, self.post().streaming_content)}
        self.assertEqual(len(answers), 4)
        self.assertEqual(answers[0]["status"], 429)
        self.assertEqual(answers[1]["retry_after"], 7)
        self.assertEqual(answers[2]["status"], 502)
        self.assertEqual(answers[3]["decision"], "SUPPORTED")
        self.assertNotIn("private", json.dumps(answers))
        self.assertEqual(PageCheck.objects.count(), 1)

    @patch("factcheck.views.retrieve_many", return_value=[ARTICLES, ARTICLES])
    @patch("factcheck.views.decide_or_error", return_value=(RESULT, ARTICLES))
    def test_nonstreaming_contract_keeps_ordered_results(self, decide, retrieve):
        response = self.post(count=2, stream=False)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([answer["sentence_id"] for answer in response.json()["results"]], ["s-0", "s-1"])
        retrieve.assert_called_once()
        self.assertEqual(PageCheck.objects.count(), 2)

    @patch("factcheck.views.retrieve_many")
    def test_invalid_requests_do_not_start_work(self, retrieve):
        for extra, status in [({"password": "bad"}, 401), ({"stream": "true"}, 400), ({"items": []}, 400)]:
            self.assertEqual(self.post(**extra).status_code, status)
        retrieve.assert_not_called()
