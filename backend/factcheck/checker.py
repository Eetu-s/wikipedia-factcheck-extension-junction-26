from dataclasses import dataclass, field
from enum import StrEnum


class Decision(StrEnum):
    SUPPORTED = "SUPPORTED"
    REFUTED = "REFUTED"
    NOT_ENOUGH_INFO = "NOT ENOUGH INFO"


@dataclass
class FactCheckResult:
    decision: Decision
    confidence: float  # 0.0–1.0
    sources: list[str] = field(default_factory=list)  # Source URLs backing the decision.


def check(text: str) -> FactCheckResult:
    # TODO: implement the actual fact check.
    return FactCheckResult(decision=Decision.NOT_ENOUGH_INFO, confidence=0.0, sources=[])
