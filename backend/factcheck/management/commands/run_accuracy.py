"""Explicit one-time evaluation; never imported or invoked by a page request."""
import fcntl
import shutil
import time
import uuid

import requests
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from wikirag import config
from wikirag.db import connect

from factcheck.accuracy import dataset, now, read_snapshot, results_path, saved_path, write_snapshot
from factcheck.analysis import analyze_errors
from factcheck.checker import Decision, GEMINI_MODEL, check


class Command(BaseCommand):
    help = "Evaluate the 100 true / 100 false statements once and save results for /accuracy."

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--resume", action="store_true", help="Process only never-attempted statements; never retry a model call.")
        group.add_argument("--rerun", action="store_true", help="Explicitly archive prior results and authorize a fresh run of all statements.")

    def handle(self, *args, **options):
        path = results_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.with_suffix(".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise CommandError("An accuracy evaluation is already running.") from error
            self.run(options)

    def preflight(self):
        if not settings.GEMINI_API_KEY:
            raise CommandError("GEMINI_API_KEY is not configured. No model calls were made.")
        try:
            con = connect(connect_timeout=5, read_timeout=10)
            try:
                with con.cursor() as cursor:
                    cursor.execute("SELECT EXISTS(SELECT 1 FROM article_vector LIMIT 1)")
                    if not cursor.fetchone()[0]:
                        raise ValueError("Wikipedia vectors are not loaded.")
            finally:
                con.close()
            response = requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=10)
            response.raise_for_status()
            models = response.json().get("models", [])
            if not any(model.get("name", "").split(":")[0] == config.EMBED_MODEL.split(":")[0] for model in models):
                raise ValueError(f"Pull the {config.EMBED_MODEL} embedding model into Ollama first.")
        except Exception as error:
            raise CommandError(f"Backend preflight failed: {error}. No model calls were made.") from error

    def run(self, options):
        fingerprint, rows = dataset()
        existing = saved_path()
        if existing.exists() and not (options["resume"] or options["rerun"]):
            raise CommandError("Saved results already exist. Nothing was run. Use --resume for untouched statements or explicitly --rerun for a new evaluation.")
        if options["resume"]:
            snapshot = read_snapshot()
            if snapshot is None:
                raise CommandError("No saved run to resume. Run without --resume to start once.")
            if not any(row[label]["status"] == "pending" for row in snapshot["rows"] for label in ("true", "false")):
                self.stdout.write("No untouched statements remain. No model calls were made.")
                return
            if (snapshot["fast_model"] != GEMINI_MODEL or snapshot["analysis_model"] != settings.GEMINI_EXPLAIN_MODEL):
                raise CommandError("Configured models differ from the saved run; refusing to mix model versions.")
        else:
            snapshot = {"version": 1, "run_id": str(uuid.uuid4()), "dataset_sha256": fingerprint,
                        "fast_model": GEMINI_MODEL, "analysis_model": settings.GEMINI_EXPLAIN_MODEL,
                        "started_at": now(), "finished_at": None, "rows": rows}
        self.preflight()
        if options["rerun"] and existing.exists():
            archive = existing.with_name(f"accuracy-results-{uuid.uuid4().hex}.json")
            shutil.copy2(existing, archive)
            self.stdout.write(f"Archived previous results: {archive}")
        snapshot["finished_at"] = None
        write_snapshot(snapshot)
        for row in snapshot["rows"]:
            for label in ("true", "false"):
                sample = row[label]
                if sample["status"] != "pending":
                    continue
                # Persist BEFORE the external call. Ambiguous/interrupted calls are never retried.
                sample.update(status="started", started_at=now())
                write_snapshot(snapshot)
                started = time.monotonic()
                try:
                    verdict, articles = check(sample["text"])
                except Exception as error:
                    sample.update(status="error", error=type(error).__name__, finished_at=now())
                    write_snapshot(snapshot)
                    raise CommandError(
                        f"Stopped at row {row['number']} ({label}): {error}. The failed attempt was saved; "
                        "--resume will skip it and process only untouched statements."
                    ) from error
                sample.update(status="done", decision=verdict.decision.value, confidence=verdict.confidence,
                              sources=verdict.sources, latency_ms=round((time.monotonic() - started) * 1000),
                              finished_at=now())
                write_snapshot(snapshot)
                self.stdout.write(f"{row['number']:03d} {label}: {verdict.decision.value}")
                if verdict.decision != Decision.REFUTED:
                    continue
                sample["analysis_status"] = "started"
                write_snapshot(snapshot)
                try:
                    analysis = analyze_errors(sample["text"], articles)
                    sample["corrections"] = [
                        {"text": error.get("corrected_text") or error["explanation"],
                         "evidence": error.get("evidence", [])}
                        for error in analysis["errors"]
                    ]
                    sample["analysis_status"] = "done"
                    sample["analysis_incomplete"] = analysis.get("incomplete", False)
                except Exception as error:
                    sample["analysis_status"] = "error"
                    sample["analysis_error"] = type(error).__name__
                    self.stderr.write(f"{row['number']:03d} {label}: correction unavailable; no retry.")
                write_snapshot(snapshot)
        snapshot["finished_at"] = now()
        write_snapshot(snapshot)
        self.stdout.write(self.style.SUCCESS(f"Saved {results_path()}. /accuracy only reads this snapshot; it never runs the model."))
