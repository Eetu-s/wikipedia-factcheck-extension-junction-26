import io
import json
import urllib.error
from unittest.mock import patch

import pymysql
from django.contrib.auth.hashers import make_password
from django.test import SimpleTestCase, TestCase, override_settings


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
@patch("factcheck.views.start_explanation", return_value="explanation-id")
@patch("factcheck.checker.search_wikipedia", return_value=FAKE_ARTICLES)
class FactCheckTests(TestCase):
    def post(self, text="The Eiffel Tower was completed in 1889.", password="pw"):
        return self.client.post(
            "/api/factcheck/", {"text": text, "password": password}, content_type="application/json"
        )

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_returns_gemini_decision(self, urlopen, search, start_explanation):
        urlopen.return_value = fake_gemini_response("supported", 0.97)
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "decision": "SUPPORTED",
                "confidence": 0.97,
                "sources": ["https://en.wikipedia.org/wiki/Eiffel_Tower"],
                "explanation_id": "explanation-id",
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
    def test_maps_all_choices(self, urlopen, search, start_explanation):
        for choice, decision in [("refuted", "REFUTED"), ("not_enough_info", "NOT ENOUGH INFO")]:
            urlopen.return_value = fake_gemini_response(choice, 0.8)
            self.assertEqual(self.post().json()["decision"], decision)

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_wrong_password_does_not_call_gemini(self, urlopen, search, start_explanation):
        self.assertEqual(self.post(password="wrong").status_code, 401)
        urlopen.assert_not_called()

    @patch("factcheck.checker.urllib.request.urlopen")
    def test_gemini_error_returns_502(self, urlopen, search, start_explanation):
        urlopen.side_effect = urllib.error.HTTPError(
            "url", 429, "Too Many Requests", {}, io.BytesIO(b"quota exceeded")
        )
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("429", response.json()["error"])

    @override_settings(GEMINI_API_KEY="")
    def test_missing_gemini_key_returns_502(self, search, start_explanation):
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertIn("GEMINI_API_KEY", response.json()["error"])


def row(url, distance, title="T", text="text", page_id=None):
    return {"lang": "en", "page_id": page_id if page_id is not None else hash(url), "title": title,
            "url": url, "distance": distance, "text": text}


class FuseRankingsTests(SimpleTestCase):
    def fuse(self, *rankings, limit=3):
        from .checker import fuse_rankings

        return [r["url"] for r in fuse_rankings(list(rankings), limit)]

    def test_takes_turns_starting_with_the_closest_ranking(self):
        paragraphs = [row("p1", 0.40), row("p2", 0.43), row("p3", 0.44)]
        articles = [row("a1", 0.47), row("a2", 0.48)]
        self.assertEqual(self.fuse(articles, paragraphs), ["p1", "a1", "p2"])

    def test_skips_distant_results_and_duplicate_articles(self):
        paragraphs = [row("p1", 0.30, page_id=1), row("p2", 0.35)]
        articles = [row("a1", 0.32, page_id=1), row("a2", 0.6)]  # same article as p1; too far
        self.assertEqual(self.fuse(paragraphs, articles), ["p1", "p2"])

    def test_no_results(self):
        self.assertEqual(self.fuse([], [row("far", 0.9)]), [])


class SearchWikipediaTests(SimpleTestCase):
    @patch("factcheck.checker.connect")
    @patch("factcheck.checker.embed_many", return_value=[[0.1] * 1024])
    @patch("factcheck.checker.chunk_search", return_value=[row("https://en.wikipedia.org/wiki/P", 0.2)])
    @patch("factcheck.checker.semantic_search")
    def test_missing_table_is_skipped(self, semantic_search, chunk_search, embed, connect):
        from .checker import search_wikipedia

        semantic_search.side_effect = pymysql.ProgrammingError(1146, "Table doesn't exist")
        articles = search_wikipedia("claim")
        self.assertEqual([a["url"] for a in articles], ["https://en.wikipedia.org/wiki/P"])
        embed.assert_called_once_with(["claim"])  # embedded once, shared by both searches
        self.assertEqual(chunk_search.call_args.kwargs["vector"], [0.1] * 1024)

    @patch("factcheck.checker.connect")
    @patch("factcheck.checker.embed_many", return_value=[[0.1] * 1024])
    @patch("factcheck.checker.chunk_search", return_value=[])
    @patch("factcheck.checker.semantic_search")
    def test_other_database_errors_fail(self, semantic_search, chunk_search, embed, connect):
        from .checker import CheckerError, search_wikipedia

        semantic_search.side_effect = pymysql.ProgrammingError(1064, "Syntax error")
        with self.assertRaises(CheckerError):
            search_wikipedia("claim")


class ArticleExcerptTests(SimpleTestCase):
    def paragraphs(self, count, size=10):
        return [(seq, f"p{seq}".ljust(size, ".")) for seq in range(count)]

    def test_whole_article_when_it_fits(self):
        from wikirag.search import article_excerpt

        text = article_excerpt(self.paragraphs(3), matched=[2], max_chars=1000)
        self.assertEqual(text, "p0........\n\np1........\n\np2........")

    def test_lead_and_neighbours_of_matches_when_too_long(self):
        from wikirag.search import article_excerpt

        text = article_excerpt(self.paragraphs(20), matched=[10], max_chars=100)
        self.assertEqual(text.split("\n\n"), [
            "p0........", "p1........", "[...]", "p8........", "p9........", "p10.......",
            "p11.......", "p12.......", "[...]",
        ])
