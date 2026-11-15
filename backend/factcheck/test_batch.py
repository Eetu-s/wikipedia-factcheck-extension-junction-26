"""Page-scan batching: evidence stays exact while duplicate retrieval work is shared."""
import json
import threading
from unittest.mock import Mock, patch

from django.contrib.auth.hashers import make_password
from django.test import SimpleTestCase, TestCase, override_settings

from .checker import CheckerError, Decision, FactCheckResult, search_wikipedia_many
from .models import Explanation, PageCheck


ARTICLES = [{"title": "Tower", "url": "https://en.wikipedia.org/wiki/Tower",
             "text": "The tower was completed in 1889."}]
OUTCOME = (FactCheckResult(Decision.SUPPORTED, .95, [ARTICLES[0]["url"]]), ARTICLES)


@override_settings(FACTCHECK_PASSWORD_HASH=make_password("pw"),
                   SECURE_SSL_REDIRECT=False)
class BatchAPITests(TestCase):
    def post(self, items=None, **options):
        payload = {"password": "pw", "items": items if items is not None else [
            {"text": "  It was completed in 1889. 🗼", "sentence_id": "s-1",
             "context": {"page_title": "Tower"}},
            {"text": "It stands in Paris.", "sentence_id": "s-2"},
        ], **options}
        return self.client.post("/api/factcheck/batch/", payload, content_type="application/json")

    @patch("factcheck.views.retrieve_many")
    def test_invalid_batches_never_start_retrieval(self, retrieve):
        for options, expected in [
            ({"password": "wrong"}, 401),
            ({"items": []}, 400),
            ({"items": [{}]}, 400),
            ({"items": [{"text": "Claim.", "context": []}]}, 400),
            ({"items": [{"text": "Claim.", "sentence_id": []}]}, 400),
            ({"items": [{"text": "Claim."}] * 11}, 400),
            ({"stream": "true"}, 400),
        ]:
            with self.subTest(options=options):
                self.assertEqual(self.post(**options).status_code, expected)
        retrieve.assert_not_called()

    @patch("factcheck.views.decide_or_error")
    @patch("factcheck.views.retrieve_many", return_value=[ARTICLES, ARTICLES])
    def test_json_results_keep_order_and_save_inputs_without_deep_work(self, retrieve, decide):
        def answer(item, articles):
            return OUTCOME if item[0].startswith("  ") else CheckerError("quota", retry_after=7)

        decide.side_effect = answer
        response = self.post()
        self.assertEqual(response.status_code, 200)
        answers = response.json()["results"]
        self.assertEqual([answer["sentence_id"] for answer in answers], ["s-1", "s-2"])
        self.assertEqual(answers[1]["status"], 429)
        self.assertEqual(answers[1]["retry_after"], 7)
        row = PageCheck.objects.get(pk=answers[0]["check_id"])
        self.assertEqual(row.original_text, "  It was completed in 1889. 🗼")
        self.assertEqual(row.context, {"page_title": "Tower"})
        self.assertEqual(row.evidence, ARTICLES)
        self.assertIsNone(row.explanation_id)
        self.assertEqual(PageCheck.objects.count(), 1)
        self.assertFalse(Explanation.objects.exists())
        retrieve.assert_called_once_with([
            ("  It was completed in 1889. 🗼", {"page_title": "Tower"}),
            ("It stands in Paris.", {}),
        ])

    @patch("factcheck.views.decide_or_error")
    @patch("factcheck.views.retrieve_many", return_value=[ARTICLES, ARTICLES])
    def test_stream_delivers_fast_sentence_before_straggler_and_persists_before_delivery(self, retrieve, decide):
        release = threading.Event()

        def answer(item, articles):
            if item[0].startswith("  "):
                if not release.wait(5):
                    raise AssertionError("The stream waited for a straggler before delivering its first result.")
            return OUTCOME

        decide.side_effect = answer
        response = self.post(stream=True)
        self.assertEqual(response["Content-Type"], "application/x-ndjson")
        self.assertEqual(response["X-Accel-Buffering"], "no")
        iterator = iter(response.streaming_content)
        try:
            first = json.loads(next(iterator))
            self.assertEqual(first["index"], 1)
            self.assertEqual(first["sentence_id"], "s-2")
            self.assertTrue(PageCheck.objects.filter(pk=first["check_id"]).exists())
        finally:
            release.set()
        second = json.loads(next(iterator))
        self.assertEqual(second["index"], 0)
        self.assertTrue(PageCheck.objects.filter(pk=second["check_id"]).exists())
        self.assertEqual(list(iterator), [])
        self.assertFalse(Explanation.objects.exists())
        response.close()

    @patch("factcheck.views.decide_or_error")
    @patch("factcheck.views.retrieve_many", side_effect=CheckerError("database down"))
    def test_retrieval_failure_is_regular_502_before_stream_starts(self, retrieve, decide):
        response = self.post(stream=True)
        self.assertEqual(response.status_code, 502)
        self.assertFalse(response.streaming)
        self.assertFalse(PageCheck.objects.exists())
        decide.assert_not_called()

    @patch("factcheck.views.BATCH_DECISION_WORKERS", 1)
    @patch("factcheck.views.decide_or_error")
    @patch("factcheck.views.retrieve_many", return_value=[ARTICLES] * 3)
    def test_closing_stream_cancels_decisions_still_waiting_for_a_worker(self, retrieve, decide):
        started, release, finished, queued = [threading.Event() for _ in range(4)]

        def answer(item, articles):
            if item[0] == "Second.":
                started.set()
                try:
                    release.wait(5)
                finally:
                    finished.set()
            elif item[0] == "Third.":
                queued.set()
            return OUTCOME

        decide.side_effect = answer
        response = self.post(items=[{"text": text} for text in ("First.", "Second.", "Third.")],
                             stream=True)
        try:
            first = json.loads(next(iter(response.streaming_content)))
            self.assertEqual(first["index"], 0)
            self.assertTrue(started.wait(5))
            response.close()
        finally:
            release.set()
        self.assertTrue(finished.wait(5))
        self.assertFalse(queued.is_set())
        self.assertEqual(PageCheck.objects.count(), 1)


class RankingCursor:
    """Small DB-API fixture using real RAG search SQL, without MariaDB or model calls."""
    def __init__(self):
        self.queries = []
        self.description = []
        self.rows = []

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        if "FROM article_vector" in sql:
            columns = ["lang", "page_id", "wikidata_id", "title", "url", "distance"]
            self.rows = [("en", i, f"Q{i}", f"Article {i}", f"https://example.org/{i}", distance)
                         for i, distance in ((1, .2), (2, .3), (3, .4))]
        elif "FROM chunk_vector" in sql:
            columns = ["lang", "page_id", "seq", "title", "url", "distance"]
            self.rows = [("en", i, 10, f"Article {i}", f"https://example.org/{i}", distance)
                         for i, distance in ((4, .25), (5, .35), (6, .45))]
        elif sql.startswith("SELECT lang, page_id, text FROM article"):
            columns = []
            self.rows = [("en", i, f"Full article {i}.") for i in params[1::2]]
        elif sql.startswith("SELECT lang, page_id, seq, text FROM chunk"):
            columns = []
            self.rows = [("en", i, seq, f"Paragraph {seq} of article {i}.")
                         for i in params[1::2] for seq in range(20)]
        elif sql.startswith("SET SESSION"):
            columns, self.rows = [], []
        else:
            raise AssertionError(f"Unexpected retrieval query: {sql}")
        self.description = [(column,) for column in columns]

    def fetchall(self):
        return self.rows


class BatchedRetrievalTests(SimpleTestCase):
    def test_standalone_chunk_search_still_includes_full_evidence_by_default(self):
        from wikirag.search import chunk_search

        cursor = RankingCursor()
        results = chunk_search(cursor, "A claim.", vector=[.1] * 1024)
        self.assertEqual([result["page_id"] for result in results], [4, 5, 6])
        for result in results:
            self.assertEqual(result["text"], "\n\n".join(
                f"Paragraph {seq} of article {result['page_id']}." for seq in range(20)))
        self.assertEqual(len(cursor.queries), 3)  # configure, rank, one body query for all three

    @patch("factcheck.checker.connect")
    @patch("factcheck.checker.embed_many", return_value=[[.1] * 1024] * 8)
    def test_fuses_before_loading_unique_bodies_and_preserves_evidence(self, embed, connect):
        cursor = RankingCursor()
        connect.return_value.cursor.return_value = cursor
        results = search_wikipedia_many([f"Sentence {i}." for i in range(8)])
        self.assertEqual(len(results), 8)
        for result in results:
            self.assertEqual([article["title"] for article in result], ["Article 1", "Article 4", "Article 2"])
            self.assertEqual(result[0]["text"], "Full article 1.")
            self.assertEqual(result[2]["text"], "Full article 2.")
            self.assertEqual(result[1]["text"], "\n\n".join(
                f"Paragraph {seq} of article 4." for seq in range(20)))
        text_queries = [(sql, params) for sql, params in cursor.queries if sql.startswith("SELECT lang, page_id")]
        self.assertEqual(len(text_queries), 2)
        self.assertEqual(text_queries[0][1], ["en", 1, "en", 2])
        self.assertEqual(text_queries[1][1], ["en", 4])
        self.assertEqual(len(cursor.queries), 8 * 4 + 2)
        embed.assert_called_once()
        connect.return_value.close.assert_called_once()

    @patch("factcheck.checker.connect")
    @patch("factcheck.checker.embed_many", return_value=[[.1] * 1024] * 2)
    @patch("factcheck.checker.chunk_search")
    @patch("factcheck.checker.semantic_search", return_value=[])
    def test_long_chunk_articles_keep_each_sentences_own_matching_paragraphs(self, semantic, chunk, embed, connect):
        from wikirag.search import article_excerpt

        paragraphs = [(seq, f"Paragraph {seq}. ".ljust(2500, ".")) for seq in range(20)]
        cursor = Mock()
        cursor.fetchall.return_value = [("en", 4, seq, text) for seq, text in paragraphs]
        connect.return_value.cursor.return_value = cursor
        chunk.side_effect = [[{"lang": "en", "page_id": 4, "title": "Long", "url": "long",
                               "distance": .2, "matched": [matched]}] for matched in (5, 15)]
        results = search_wikipedia_many(["Early topic.", "Late topic."])
        self.assertEqual(results[0][0]["text"], article_excerpt(paragraphs, [5], 40_000))
        self.assertEqual(results[1][0]["text"], article_excerpt(paragraphs, [15], 40_000))
        self.assertNotEqual(results[0][0]["text"], results[1][0]["text"])
        cursor.execute.assert_called_once()
