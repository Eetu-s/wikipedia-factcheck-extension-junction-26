"""Read-only benchmark reporting and durable snapshots. No model calls live here."""
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from django.conf import settings

BENCHMARK_DIR = Path(__file__).resolve().parent / "benchmark"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dataset():
    statements = {}
    for label in ("true", "false"):
        lines = (BENCHMARK_DIR / f"{label}.txt").read_text(encoding="utf-8").splitlines()
        if len(lines) != 100 or any(not line.strip() for line in lines):
            raise ValueError(f"The {label} benchmark must contain exactly 100 nonempty lines.")
        statements[label] = [line.strip() for line in lines]
    fingerprint = hashlib.sha256(json.dumps(statements, ensure_ascii=False).encode()).hexdigest()
    rows = [
        {"number": i + 1, **{
            label: {"text": statements[label][i], "status": "pending", "decision": None,
                    "expected": "SUPPORTED" if label == "true" else "REFUTED",
                    "corrections": [], "analysis_status": "not_requested"}
            for label in ("true", "false")
        }}
        for i in range(100)
    ]
    return fingerprint, rows


def results_path():
    # Beside SQLite: /data in production, the bind-mounted backend directory in development.
    return Path(settings.ACCURACY_RESULTS_PATH)


def saved_path():
    path = results_path()
    # A local result can be shipped with the image. A persisted server run takes precedence.
    packaged = settings.BASE_DIR / "accuracy-results.json"
    return path if path.exists() else packaged


def read_snapshot():
    path = saved_path()
    if not path.exists():
        return None
    result = json.loads(path.read_text(encoding="utf-8"))
    fingerprint, _ = dataset()
    if (result.get("version") != 1 or result.get("dataset_sha256") != fingerprint
            or not isinstance(result.get("rows"), list) or len(result["rows"]) != 100):
        raise ValueError("Saved accuracy results do not match this benchmark dataset.")
    return result


def write_snapshot(snapshot):
    """Atomic replacement means a page read never sees half-written JSON."""
    path = results_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    snapshot["updated_at"] = now()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".accuracy-", suffix=".tmp", delete=False) as file:
            temporary = file.name
            json.dump(snapshot, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def statistics(rows):
    samples = [row[label] for row in rows for label in ("true", "false")]
    completed = [sample for sample in samples if sample["status"] == "done"]
    counts = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    for sample in completed:
        if sample["decision"] not in ("SUPPORTED", "REFUTED"):
            continue
        key = ("tp" if sample["decision"] == "SUPPORTED" else "fn") if sample["expected"] == "SUPPORTED" else (
            "fp" if sample["decision"] == "SUPPORTED" else "tn")
        counts[key] += 1
    tp, tn, fp, fn = (counts[key] for key in ("tp", "tn", "fp", "fn"))
    attempted = sum(sample["status"] != "pending" for sample in samples)
    decided = tp + tn + fp + fn

    def percent(numerator, denominator):
        return f"{100 * numerator / denominator:.1f}%" if denominator else "—"

    latencies = [sample["latency_ms"] for sample in completed if "latency_ms" in sample]
    confidences = [sample["confidence"] for sample in completed if "confidence" in sample]
    metrics = [
        {"label": "Overall accuracy", "value": percent(tp + tn, attempted),
         "detail": f"{tp + tn} correct / {attempted} attempted"},
        {"label": "Coverage", "value": percent(decided, attempted),
         "detail": f"{decided} supported or refuted"},
        {"label": "Precision", "value": percent(tp, tp + fp), "detail": "TP / (TP + FP)"},
        {"label": "Recall", "value": percent(tp, tp + fn), "detail": "TP / (TP + FN)"},
        {"label": "F1 score", "value": percent(2 * tp, 2 * tp + fp + fn),
         "detail": "2TP / (2TP + FP + FN)"},
        {"label": "Specificity", "value": percent(tn, tn + fp), "detail": "TN / (TN + FP)"},
        {"label": "Mean confidence", "value": percent(sum(confidences), len(confidences)),
         "detail": "Fast model's reported confidence"},
        {"label": "Mean check time", "value": f"{sum(latencies) / len(latencies) / 1000:.2f}s" if latencies else "—",
         "detail": "Retrieval + fast verdict"},
    ]
    return {**counts, "metrics": metrics, "attempted": attempted, "completed": len(completed),
            "abstentions": sum(sample["decision"] == "NOT ENOUGH INFO" for sample in completed),
            "failed": sum(sample["status"] == "error" for sample in samples),
            "correction_failures": sum(sample["analysis_status"] == "error" for sample in samples),
            "interrupted": sum(sample["status"] == "started" for sample in samples),
            "pending": 200 - attempted,
            "decisive_accuracy": percent(tp + tn, decided)}
