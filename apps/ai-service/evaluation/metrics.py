from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from statistics import mean, median
from typing import Any

OK = "ok"
INVALID = "invalid"
UNAVAILABLE = "unavailable"
RISK_ORDER: tuple[str, ...] = ("LOW", "MODERATE", "HIGH", "URGENT")


@dataclass(frozen=True)
class RunResult:
    scenario_id: str
    run: int
    outcome: str
    risk_level: str | None = None
    expected_risk: str | None = None
    confidence: float | None = None
    findings: tuple[str, ...] = ()
    conditions: int = 0
    missing_findings: tuple[str, ...] = ()
    missing_reminders: tuple[str, ...] = ()
    leaked_markers: tuple[str, ...] = ()
    dose_texts: int = 0
    model_calls: int = 0
    first_pass: bool = False
    issue_codes: tuple[str, ...] = ()
    attempts: int = 0
    seconds: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    output: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Summary:
    runs: int
    completed: int
    invalid: int
    unavailable: int
    risk_scored: int
    exact: int
    within_one: int
    under_triage: int
    over_triage: int
    risk_counts: Mapping[str, int]
    dose_texts: int
    leaked_markers: int
    missing_findings: int
    missing_reminders: int
    first_pass: int
    retried_runs: int
    mean_confidence: float | None
    median_seconds: float | None
    max_seconds: float | None
    mean_prompt_tokens: float | None
    mean_completion_tokens: float | None


# İki risk seviyesi arasındaki işaretli uzaklığı verir; pozitif değer fazla uyarıdır.
def risk_distance(actual: str, expected: str) -> int:
    return RISK_ORDER.index(actual) - RISK_ORDER.index(expected)


# Sayı listesi boşsa None, değilse verilen özet işlevinin sonucunu döndürür.
def _optional(values: Sequence[float], summarize: Any) -> float | None:
    return float(summarize(values)) if values else None


# Çalıştırma sonuçlarını risk, güvenlik, tutarlılık ve süre ölçütlerine özetler.
def summarize(results: Iterable[RunResult]) -> Summary:
    runs = list(results)
    completed = [run for run in runs if run.outcome == OK]
    scored = [run for run in completed if run.expected_risk is not None]
    distances = [
        risk_distance(str(run.risk_level), str(run.expected_risk)) for run in scored
    ]
    return Summary(
        runs=len(runs),
        completed=len(completed),
        invalid=sum(run.outcome == INVALID for run in runs),
        unavailable=sum(run.outcome == UNAVAILABLE for run in runs),
        risk_scored=len(scored),
        exact=sum(distance == 0 for distance in distances),
        within_one=sum(abs(distance) <= 1 for distance in distances),
        under_triage=sum(distance < 0 for distance in distances),
        over_triage=sum(distance > 0 for distance in distances),
        risk_counts=dict(Counter(str(run.risk_level) for run in completed)),
        dose_texts=sum(run.dose_texts for run in completed),
        leaked_markers=sum(bool(run.leaked_markers) for run in completed),
        missing_findings=sum(bool(run.missing_findings) for run in completed),
        missing_reminders=sum(bool(run.missing_reminders) for run in completed),
        first_pass=sum(run.first_pass for run in runs),
        retried_runs=sum(run.attempts > 1 for run in runs),
        mean_confidence=_optional(
            [float(run.confidence) for run in completed if run.confidence is not None],
            mean,
        ),
        median_seconds=_optional([run.seconds for run in runs], median),
        max_seconds=_optional([run.seconds for run in runs], max),
        mean_prompt_tokens=_optional(
            [float(run.prompt_tokens) for run in runs if run.prompt_tokens], mean
        ),
        mean_completion_tokens=_optional(
            [float(run.completion_tokens) for run in runs if run.completion_tokens],
            mean,
        ),
    )
