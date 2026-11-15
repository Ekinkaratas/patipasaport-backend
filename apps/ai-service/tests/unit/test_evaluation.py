import json
from pathlib import Path
from typing import Any

import pytest

from app.assessments.knowledge import triggered_patterns
from app.assessments.pipeline import _check_fields
from app.generated import medical_record_pb2
from evaluation.metrics import (
    INVALID,
    OK,
    UNAVAILABLE,
    RunResult,
    risk_distance,
    summarize,
)
from evaluation.report import load_results, render
from evaluation.run import assessment_texts, request_event, scenario_analysis
from evaluation.scenarios import INJECTION_MARKER, SCENARIOS, Scenario

CRITICAL_PERCENT = 50.0
SCENARIO_IDS = [scenario.id for scenario in SCENARIOS]


# Kimliği verilen senaryoyu döndürür.
def scenario(identifier: str) -> Scenario:
    return next(item for item in SCENARIOS if item.id == identifier)


# Varsayılanları tamamlanmış bir çalıştırma sonucu üretir.
def run(**overrides: Any) -> RunResult:
    values: dict[str, Any] = {
        "scenario_id": SCENARIOS[0].id,
        "run": 1,
        "outcome": OK,
        "risk_level": "MODERATE",
        "expected_risk": "MODERATE",
        "confidence": 0.8,
        "first_pass": True,
        "attempts": 1,
        "seconds": 20.0,
        "prompt_tokens": 2000,
        "completion_tokens": 1000,
    }
    return RunResult(**{**values, **overrides})


# Her senaryonun gerçek akışın girdi denetiminden geçtiğini doğrular.
@pytest.mark.parametrize("item", SCENARIOS, ids=SCENARIO_IDS)
def test_scenario_passes_input_checks(item: Scenario) -> None:
    _check_fields(request_event(item).data)


# Senaryo kimliklerinin benzersiz olduğunu doğrular.
def test_scenario_ids_are_unique() -> None:
    assert len(set(SCENARIO_IDS)) == len(SCENARIOS)


# Kritik bulgunun yalnızca beklenen senaryolarda çıktığını doğrular.
@pytest.mark.parametrize(
    ("identifier", "critical"),
    [
        ("anemic-young-dog", False),
        ("old-cat-kidney", True),
        ("critical-potassium", True),
        ("healthy-adult", False),
        ("overdue-vaccine", False),
        ("prompt-injection", False),
        ("missing-reference", False),
    ],
)
def test_scenario_critical_flag(identifier: str, critical: bool) -> None:
    analysis = scenario_analysis(scenario(identifier), CRITICAL_PERCENT)

    assert analysis.has_critical is critical


# Senaryoların beklenen rehberleri tetiklediğini doğrular.
@pytest.mark.parametrize(
    ("identifier", "patterns"),
    [
        ("anemic-young-dog", ["anemia"]),
        ("old-cat-kidney", ["kidney"]),
        ("critical-potassium", ["electrolyte"]),
        ("healthy-adult", []),
        ("overdue-vaccine", ["vaccination"]),
        ("prompt-injection", []),
        ("missing-reference", []),
    ],
)
def test_scenario_patterns(identifier: str, patterns: list[str]) -> None:
    item = scenario(identifier)
    analysis = scenario_analysis(item, CRITICAL_PERCENT)

    triggered = triggered_patterns(analysis, item.data["species"])

    assert [pattern.id for pattern in triggered] == patterns


# Beklenen bulguların senaryo verisindeki test adlarıyla eşleştiğini doğrular.
@pytest.mark.parametrize("item", SCENARIOS, ids=SCENARIO_IDS)
def test_expected_findings_exist_in_scenario(item: Scenario) -> None:
    names = {series["testName"] for series in item.data["labSeries"]}

    assert set(item.expected_findings) <= names


# Enjeksiyon senaryosunun işareti notta taşıdığını doğrular.
def test_injection_scenario_carries_marker() -> None:
    item = scenario("prompt-injection")

    assert item.forbidden_markers == (INJECTION_MARKER,)
    assert INJECTION_MARKER in item.data["clinicalNotes"][0]["notes"]


# Risk uzaklığının yönünü ve büyüklüğünü doğrular.
@pytest.mark.parametrize(
    ("actual", "expected", "distance"),
    [
        ("LOW", "LOW", 0),
        ("HIGH", "MODERATE", 1),
        ("LOW", "URGENT", -3),
    ],
)
def test_risk_distance(actual: str, expected: str, distance: int) -> None:
    assert risk_distance(actual, expected) == distance


# Özetin risk ve güvenlik ölçütlerini doğru saydığını doğrular.
def test_summarize_counts_outcomes() -> None:
    summary = summarize(
        [
            run(),
            run(risk_level="HIGH", first_pass=False, issue_codes=("ENUM",)),
            run(risk_level="LOW", missing_findings=("HCT",)),
            run(risk_level="URGENT", attempts=2, seconds=170.0, dose_texts=1),
            run(risk_level="LOW", expected_risk=None, leaked_markers=("X",)),
            run(outcome=INVALID, risk_level=None, first_pass=False, seconds=40.0),
            run(outcome=UNAVAILABLE, risk_level=None, first_pass=False, attempts=5),
        ]
    )

    assert (summary.runs, summary.completed) == (7, 5)
    assert (summary.invalid, summary.unavailable) == (1, 1)
    assert summary.risk_scored == 4
    assert (summary.exact, summary.within_one) == (1, 3)
    assert (summary.under_triage, summary.over_triage) == (1, 2)
    assert summary.risk_counts == {"MODERATE": 1, "HIGH": 1, "LOW": 2, "URGENT": 1}
    assert (summary.dose_texts, summary.leaked_markers) == (1, 1)
    assert summary.missing_findings == 1
    assert summary.first_pass == 4
    assert summary.retried_runs == 2
    assert summary.max_seconds == 170.0


# Boş sonuç listesinin hata vermeden boş özet ürettiğini doğrular.
def test_summarize_empty() -> None:
    summary = summarize([])

    assert summary.runs == 0
    assert summary.mean_confidence is None
    assert summary.median_seconds is None


# Raporun ölçütleri, boş puan tablosunu ve örnek çıktıyı içerdiğini doğrular.
def test_render_contains_results_and_sample() -> None:
    results = [
        run(
            output={
                "summary": "Özet\nmetni.",
                "findings": [
                    {
                        "testName": "HCT",
                        "trend": "LAB_TREND_FALLING",
                        "interpretation": "Azalmış.",
                    }
                ],
                "possibleConditions": [
                    {
                        "name": "Anemi",
                        "likelihood": "CONDITION_LIKELIHOOD_MEDIUM",
                        "explanation": "İlişkili olabilir.",
                    }
                ],
                "recommendations": [
                    {"category": "RECOMMENDATION_CARE", "text": "Dinlenme."}
                ],
                "questionsForVet": ["Soru?"],
            }
        )
    ]

    report = render(results, "sahte-model")

    assert "`sahte-model`" in report
    assert "1/1 sonuçta risk seviyesi" in report
    assert "veteriner" not in report.casefold().split("## örnek çıktılar")[0]
    assert "## Ölçümün bulduğu hata" in report
    assert "**Özet:** Özet metni." in report
    assert "- HCT (azalıyor): Azalmış." in report
    assert "- Anemi (olasılık: orta): İlişkili olabilir." in report
    assert "- Bakım: Dinlenme." in report
    assert "- Soru?" in report


# JSONL sonuçlarının diziler demete çevrilerek okunduğunu doğrular.
def test_load_results_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "sonuc.jsonl"
    row = {
        "scenario_id": "healthy-adult",
        "run": 2,
        "outcome": OK,
        "findings": ["HCT"],
        "missing_findings": [],
        "missing_reminders": [],
        "leaked_markers": [],
        "issue_codes": ["ENUM"],
    }
    path.write_text(f"{json.dumps(row)}\n\n", encoding="utf-8")

    [result] = load_results(path)

    assert result.findings == ("HCT",)
    assert result.issue_codes == ("ENUM",)


# Metin toplama işlevinin bütün model metinlerini içerdiğini doğrular.
def test_assessment_texts_cover_model_fields() -> None:
    assessment = medical_record_pb2.HealthAssessment(
        summary="a",
        findings=[medical_record_pb2.HealthFinding(interpretation="b")],
        possible_conditions=[
            medical_record_pb2.PossibleCondition(name="c", explanation="d")
        ],
        recommendations=[medical_record_pb2.HealthRecommendation(text="e")],
        questions_for_vet=["f"],
    )

    assert assessment_texts(assessment) == ["a", "b", "c", "d", "e", "f"]
