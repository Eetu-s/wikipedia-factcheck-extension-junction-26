"""Structured factual-error analysis for refuted claims."""

from .explainer import ExplainerError, generate_json


ANALYSIS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "errors": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "original_text": {"type": "STRING"},
                    "explanation": {"type": "STRING"},
                    "corrected_text": {"type": "STRING"},
                    "evidence": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "article": {"type": "INTEGER"},
                                "quote": {"type": "STRING"},
                            },
                            "required": ["article", "quote"],
                        },
                    },
                },
                "required": ["original_text", "explanation", "corrected_text", "evidence"],
            },
        },
        "unverified_facts": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "text": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                },
                "required": ["text", "reason"],
            },
        },
        "incomplete": {"type": "BOOLEAN"},
    },
    "required": ["errors", "unverified_facts", "incomplete"],
}


PROMPT = """Claim to analyze:
{claim}

The fast fact-check verdict was REFUTED. Identify each independently incorrect factual
statement in the claim. Use only the supplied Wikipedia article text as evidence.
For every error, copy a short exact phrase from the claim as original_text, explain the
problem, provide a corrected_text, and include exact supporting quotes with the article
number. Put statements that cannot be verified from these articles in unverified_facts.
If the supplied articles do not allow a complete analysis, set incomplete to true.
Return JSON only.

Wikipedia articles:
{articles}"""


def analyze_errors(claim: str, articles: list[dict]) -> dict:
    numbered = "\n\n".join(
        f"[Article {i}] {article['title']} ({article['url']})\n{article['text']}"
        for i, article in enumerate(articles, 1)
    )
    result = generate_json(
        PROMPT.format(claim=claim, articles=numbered), ANALYSIS_SCHEMA
    )
    if not isinstance(result, dict):
        raise ExplainerError("Gemini's analysis was not an object.")

    errors = []
    for raw in result.get("errors", []):
        if not isinstance(raw, dict):
            continue
        original = str(raw.get("original_text", "")).strip()
        if not original:
            continue
        start = claim.find(original)
        if start < 0:
            continue
        evidence = []
        for item in raw.get("evidence", []):
            if not isinstance(item, dict):
                continue
            article_number = item.get("article")
            quote = str(item.get("quote", "")).strip()
            if isinstance(article_number, int) and 1 <= article_number <= len(articles) and quote:
                evidence.append({"source": articles[article_number - 1]["url"], "quote": quote})
        if not evidence:
            continue
        errors.append(
            {
                "original_text": original,
                "start": start,
                "end": start + len(original),
                "explanation": str(raw.get("explanation", "")).strip(),
                "corrected_text": str(raw.get("corrected_text", "")).strip(),
                "evidence": evidence,
            }
        )

    unverified = []
    for item in result.get("unverified_facts", []):
        if isinstance(item, dict) and str(item.get("text", "")).strip():
            unverified.append(
                {
                    "text": str(item["text"]).strip(),
                    "reason": str(item.get("reason", "")).strip(),
                }
            )
    return {
        "errors": errors,
        "unverified_facts": unverified,
        "incomplete": bool(result.get("incomplete", False)),
    }
