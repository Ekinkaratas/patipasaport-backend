import copy
import dataclasses
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any, cast

import pytest

from app.assessments import validate
from app.assessments.analyze import analyze
from app.assessments.knowledge import ANEMIA, VACCINATION, triggered_patterns
from app.assessments.pipeline import (
    CATEGORY_VALUES,
    LIKELIHOOD_VALUES,
    RISK_LEVEL_VALUES,
    AssessmentPipeline,
)
from app.assessments.validate import AssessmentInvalid, validate_assessment
from app.errors import (
    AI_PROVIDER_REJECTED,
    AI_PROVIDER_UNAVAILABLE,
    EXPLANATION_ERROR_MESSAGES,
    INTERNAL_ERROR,
    INVALID_AI_OUTPUT,
    PermanentError,
    TransientError,
)
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import (
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    LlmReply,
    UnexpectedStatusError,
)
from app.llm.prompts import (
    build_assess_system_prompt,
    build_assess_task_text,
    build_assessment_correction_text,
)
from app.llm.schemas import ASSESSMENT_SCHEMA, ASSESSMENT_SCHEMA_NAME
from app.logs import JsonFormatter
from app.messaging.cloudevents import (
    DOCUMENT_UPLOADED,
    HEALTH_ASSESSMENT_FAILED,
    HEALTH_ASSESSMENT_GENERATED,
    HEALTH_ASSESSMENT_REQUESTED,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    parse_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import UNROUTABLE, Publisher, PublishError
from app.messaging.topology import ASSESSMENT_PREFETCH, Topology
from app.validation import ValidationIssue

REQUEST_ID = "4e8b1d2c-6a3f-4c7e-9b0d-2f1a3c5e7d9b"
EVENT_ID = "8a6c4e2f-0b1d-4f3a-9c5e-7d9b1a3c5e7f"
MEDICAL_RECORD_SOURCE = "/patipasaport/medical-record"
FAKE_MODEL = "sahte-model"
MODEL_VERSION = "sahte-model/assess-v1"
CRITICAL_PERCENT = 50.0
AS_OF = date(2026, 10, 21)
EVENT_TIME = datetime(2026, 10, 21, 9, 30, tzinfo=UTC)
GENERATED_AT = datetime(
    2026, 10, 21, 12, 30, 8, 456789, tzinfo=timezone(timedelta(hours=3))
)
GENERATED_AT_TEXT = "2026-10-21T09:30:08.456Z"
FAILED_AT = datetime(2026, 10, 21, 9, 32, 30)
FAILED_AT_TEXT = "2026-10-21T09:32:30.000Z"
SECRET_MARKER = "GIZLI-SAGLIK-ICERIGI-5T"
PIPELINE_LOGGER = "AssessmentPipeline"
PIPELINE_LOG_FIELDS = frozenset({"requestId", "durationMs", "model"})
STANDARD_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
}
TIME_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"
)
SUCCESS_MESSAGE = "Sağlık değerlendirmesi üretildi ve yayınlandı"
INCOMPLETE_MESSAGE = "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor"
FLOW_CODES = (
    INVALID_AI_OUTPUT,
    AI_PROVIDER_REJECTED,
    AI_PROVIDER_UNAVAILABLE,
    INTERNAL_ERROR,
)
LOW = medical_record_pb2.LabResultFlag.LOW
UNSPECIFIED = medical_record_pb2.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED

VALID_OUTPUT_DATA: dict[str, Any] = {
    "confidence": 0.74,
    "riskLevel": "MODERATE",
    "summary": f"HCT son ölçümlerde azalıyor. {SECRET_MARKER}",
    "findings": [
        {"testName": "HGB", "interpretation": "HGB aralığın içinde."},
        {"testName": "HCT", "interpretation": f"HCT düşüyor. {SECRET_MARKER}"},
    ],
    "possibleConditions": [
        {
            "name": "Kansızlıkla ilişkili bir durum",
            "likelihood": "MEDIUM",
            "evidence": ["HCT", "HGB"],
            "explanation": "Düşen HCT kansızlıkla ilişkili olabilir.",
        }
    ],
    "recommendations": [
        {"category": "VET_VISIT", "text": "Veteriner hekiminize danışın."},
        {"category": "VACCINATION", "text": "Gecikmiş aşı için randevu alın."},
    ],
    "questionsForVet": ["Kontrol hemogramı gerekir mi?"],
}
EXPECTED_ASSESSMENT: dict[str, Any] = {
    "summary": f"HCT son ölçümlerde azalıyor. {SECRET_MARKER}",
    "riskLevel": "HEALTH_RISK_MODERATE",
    "findings": [
        {
            "testName": "HGB",
            "trend": "LAB_TREND_SINGLE",
            "interpretation": "HGB aralığın içinde.",
        },
        {
            "testName": "HCT",
            "trend": "LAB_TREND_FALLING",
            "interpretation": f"HCT düşüyor. {SECRET_MARKER}",
        },
    ],
    "possibleConditions": [
        {
            "name": "Kansızlıkla ilişkili bir durum",
            "likelihood": "CONDITION_LIKELIHOOD_MEDIUM",
            "evidence": ["HCT", "HGB"],
            "explanation": "Düşen HCT kansızlıkla ilişkili olabilir.",
        }
    ],
    "recommendations": [
        {
            "category": "RECOMMENDATION_VET_VISIT",
            "text": "Veteriner hekiminize danışın.",
        },
        {
            "category": "RECOMMENDATION_VACCINATION",
            "text": "Gecikmiş aşı için randevu alın.",
        },
    ],
    "vaccinationReminders": [
        {
            "vaccineName": "Kuduz",
            "nextDueAt": "2026-10-01",
            "status": "VACCINATION_OVERDUE",
        }
    ],
    "questionsForVet": ["Kontrol hemogramı gerekir mi?"],
}


# Geçerli değerlendirme çıktısını verilen değişikliklerle JSON metni olarak üretir.
def output_text(**changes: Any) -> str:
    data = copy.deepcopy(VALID_OUTPUT_DATA)
    data.update(changes)
    return json.dumps(data, ensure_ascii=False)


VALID_OUTPUT = output_text()
EMPTY_OUTPUT = output_text(
    riskLevel="HIGH", findings=[], possibleConditions=[], recommendations=[]
)
INVALID_OUTPUT = output_text(
    summary="",
    findings=[{"testName": SECRET_MARKER, "interpretation": SECRET_MARKER + chr(0)}],
)
NOT_JSON_OUTPUT = f"bu bir JSON degil {SECRET_MARKER}"


@dataclass(frozen=True)
class LlmCall:
    system_prompt: str
    user_text: str
    image_data_urls: tuple[str, ...]
    schema_name: str
    schema: Mapping[str, object]
    follow_up: tuple[ChatTurn, ...]


class FakeLlm:
    # Sahte AI API istemcisini sırayla döndüreceği çıktı ya da hatalarla kurar.
    def __init__(self, *outcomes: str | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[LlmCall] = []

    # İsteği kaydeder ve sıradaki çıktıyı döndürür ya da sıradaki hatayı fırlatır.
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_text: str,
        image_data_urls: Sequence[str] = (),
        schema_name: str,
        schema: Mapping[str, object],
        follow_up: Sequence[ChatTurn] = (),
    ) -> LlmReply:
        self.calls.append(
            LlmCall(
                system_prompt,
                user_text,
                tuple(image_data_urls),
                schema_name,
                schema,
                tuple(follow_up),
            )
        )
        if len(self.calls) > len(self.outcomes):
            raise AssertionError("Beklenenden fazla model çağrısı yapıldı")
        outcome = self.outcomes[len(self.calls) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return LlmReply(outcome, prompt_tokens=11, completion_tokens=22)


class FakePublisher:
    # Sahte yayıncıyı isteğe bağlı yayın hatasıyla kurar.
    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error
        self.events: list[OutgoingEvent] = []

    # Olayı kaydeder; tanımlıysa hatayı fırlatır.
    async def publish(self, event: OutgoingEvent) -> None:
        self.events.append(event)
        if self.error is not None:
            raise self.error


class FakeClock:
    # Sırayla verilen zamanları döndüren, sonuncusunu tekrarlayan sahte saati kurar.
    def __init__(self, *moments: datetime) -> None:
        self.moments = moments
        self.calls = 0

    # Sıradaki zamanı döndürür.
    def __call__(self) -> datetime:
        moment = self.moments[min(self.calls, len(self.moments) - 1)]
        self.calls += 1
        return moment


# Verilen alanlarla bir tahlil ölçümü üretir.
def measurement(
    sampled_at: str = "2026-10-01",
    value: str = "1",
    unit: str = "",
    reference_range: str = "",
    flag: int = UNSPECIFIED,
) -> events_pb2.LabMeasurement:
    return events_pb2.LabMeasurement(
        sampled_at=sampled_at,
        value=value,
        unit=unit,
        reference_range=reference_range,
        flag=flag,
    )


# Verilen adla ve ölçümlerle (verilmezse tek ölçümle) bir tahlil serisi üretir.
def series(
    test_name: str, *measurements: events_pb2.LabMeasurement
) -> events_pb2.LabSeries:
    return events_pb2.LabSeries(
        test_name=test_name, measurements=measurements or (measurement(),)
    )


# Verilen alan değişiklikleriyle bir aşı kaydı üretir.
def vaccination(**changes: Any) -> medical_record_pb2.VaccinationDetails:
    fields: dict[str, Any] = {
        "vaccine_name": "Kuduz",
        "batch_number": "SERI-1",
        "administered_at": "2025-10-01",
        "next_due_at": "2026-10-01",
    }
    fields.update(changes)
    return medical_record_pb2.VaccinationDetails(**fields)


# Verilen alan değişiklikleriyle bir reçete kaydı üretir.
def prescription(**changes: Any) -> medical_record_pb2.PrescriptionDetails:
    fields: dict[str, Any] = {
        "medication_name": "Sahte ilaç",
        "dosage": "1 doz",
        "frequency": "Günde bir",
        "duration_days": 7,
        "instructions": "Yemekle",
        "prescribed_at": "2026-09-01",
    }
    fields.update(changes)
    return medical_record_pb2.PrescriptionDetails(**fields)


# Verilen alan değişiklikleriyle bir klinik notu üretir.
def note(**changes: Any) -> events_pb2.ClinicalNote:
    fields: dict[str, Any] = {
        "type": medical_record_pb2.EXAMINATION,
        "title": "Genel muayene",
        "notes": "Son haftalarda halsizlik bildirildi.",
        "recorded_at": "2026-10-01",
    }
    fields.update(changes)
    return events_pb2.ClinicalNote(**fields)


# Düşen HCT ve normal HGB serilerini döndürür.
def default_series() -> list[events_pb2.LabSeries]:
    return [
        series(
            "HCT",
            measurement("2026-06-01", "41", "%", "37-55"),
            measurement("2026-10-01", "35", "%", "37-55", LOW),
            measurement("2026-08-01", "38", "%", "37-55"),
        ),
        series("HGB", measurement("2026-10-01", "14", "g/dL", "12-18")),
    ]


# Verilen alan değişiklikleriyle geçerli bir health_assessment.requested olayı üretir.
def requested_event(**changes: Any) -> IncomingEvent:
    fields: dict[str, Any] = {
        "request_id": REQUEST_ID,
        "as_of": AS_OF.isoformat(),
        "species": "DOG",
        "breed": "Golden Retriever",
        "sex": "FEMALE",
        "is_neutered": True,
        "birth_date": "2023-09-15",
        "is_birth_date_estimated": True,
        "lab_series": default_series(),
        "vaccinations": [vaccination()],
        "prescriptions": [prescription()],
        "clinical_notes": [note()],
    }
    fields.update(changes)
    return IncomingEvent(
        id=EVENT_ID,
        type=HEALTH_ASSESSMENT_REQUESTED,
        source=MEDICAL_RECORD_SOURCE,
        subject=REQUEST_ID,
        time=EVENT_TIME,
        data=events_pb2.HealthAssessmentRequested(**fields),
    )


# Sahte istemciyle, istenirse sahte saati kullanan bir değerlendirme akışı kurar.
def make_pipeline(
    llm: FakeLlm,
    clock: FakeClock | None = None,
    ai_model: str = FAKE_MODEL,
    critical_percent: float = CRITICAL_PERCENT,
) -> AssessmentPipeline:
    if clock is None:
        return AssessmentPipeline(cast(LlmClient, llm), ai_model, critical_percent)
    return AssessmentPipeline(
        cast(LlmClient, llm), ai_model, critical_percent, clock=clock
    )


# Model çıktısının doğrulama sorunlarını varsayılan istek adlarıyla hesaplar.
def issues_of(output: str) -> tuple[ValidationIssue, ...]:
    with pytest.raises(AssessmentInvalid) as raised:
        validate_assessment(output, ("HCT", "HGB"), has_critical=False)
    return raised.value.issues


# Yayınlanan olayın CloudEvents zarfını sözlük olarak döndürür.
def envelope_of(event: OutgoingEvent) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(event.body))


# Akış kayıtlarını verilen seviyeye göre süzüp döndürür.
def pipeline_records(
    caplog: pytest.LogCaptureFixture, level: int
) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == PIPELINE_LOGGER and record.levelno == level
    ]


# Akış loglarının yalnızca izin verilen ek alanları taşıdığını doğrular.
def assert_pipeline_fields(caplog: pytest.LogCaptureFixture) -> None:
    for record in caplog.records:
        if record.name == PIPELINE_LOGGER:
            extra = set(vars(record)) - STANDARD_RECORD_FIELDS
            assert extra <= PIPELINE_LOG_FIELDS
            assert record.exc_info is None


# Kayıtların JSON biçiminde ve ham alanlarında verilen metinlerin geçmediğini doğrular.
def assert_not_logged(caplog: pytest.LogCaptureFixture, *texts: str) -> None:
    formatter = JsonFormatter()
    for record in caplog.records:
        rendered = formatter.format(record) + repr(vars(record))
        for text in texts:
            assert text not in rendered


# Akışın beklenen girdiyle ürettiği talimatı ve görev metnini döndürür.
def expected_prompts(
    event: IncomingEvent, critical_percent: float = CRITICAL_PERCENT
) -> tuple[str, str]:
    data = cast(events_pb2.HealthAssessmentRequested, event.data)
    as_of = date.fromisoformat(data.as_of)
    analysis = analyze(data, as_of, critical_deviation_percent=critical_percent)
    birth_date = date.fromisoformat(data.birth_date) if data.birth_date else None
    return (
        build_assess_system_prompt(triggered_patterns(analysis, data.species)),
        build_assess_task_text(data, analysis, as_of=as_of, birth_date=birth_date),
    )


# Testteki tüm logları DEBUG seviyesinden itibaren yakalar.
@pytest.fixture(autouse=True)
def capture_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)


# modelVersion'ın kurulumda model adı ve assess-v1 sürümünden kurulduğunu doğrular.
def test_model_version_is_computed_at_construction() -> None:
    llm = FakeLlm()

    pipeline = make_pipeline(llm)

    assert pipeline.model_version == MODEL_VERSION
    assert llm.calls == []


# 64 karakteri aşan modelVersion'ın kurulumu ValueError ile durdurduğunu doğrular.
def test_too_long_model_version_raises_value_error() -> None:
    with pytest.raises(ValueError):
        make_pipeline(FakeLlm(), ai_model="m" * 55)

    assert len(make_pipeline(FakeLlm(), ai_model="m" * 54).model_version) == 64


# Akışın değerlendirme kuyruğunu, olay türünü, prefetch'i ve metotları eşlediğini sınar.
def test_flow_binds_assessment_queue_and_methods() -> None:
    pipeline = make_pipeline(FakeLlm())

    flow = pipeline.flow(Topology(assessment_queue="test-run.assessments"))

    assert flow == Flow(
        queue="test-run.assessments",
        event_type=HEALTH_ASSESSMENT_REQUESTED,
        prefetch=ASSESSMENT_PREFETCH,
        handle=pipeline.handle,
        build_failure=pipeline.build_failure,
    )
    assert pipeline.flow(Topology()).queue == "ai-service.health-assessment-requested"
    assert ASSESSMENT_PREFETCH == 2


# Başarıda yalnızca generated olayının bütün alanlarıyla yayınlandığını doğrular.
async def test_success_publishes_generated_event() -> None:
    publisher = FakePublisher()
    clock = FakeClock(GENERATED_AT)
    pipeline = make_pipeline(FakeLlm(VALID_OUTPUT), clock)

    await pipeline.handle(requested_event(), cast(Publisher, publisher))

    [event] = publisher.events
    envelope = envelope_of(event)
    assert event.type == HEALTH_ASSESSMENT_GENERATED
    assert envelope["subject"] == REQUEST_ID
    assert envelope["time"] == GENERATED_AT_TEXT
    assert envelope["data"] == {
        "requestId": REQUEST_ID,
        "modelVersion": MODEL_VERSION,
        "confidence": 0.74,
        "assessment": EXPECTED_ASSESSMENT,
        "generatedAt": GENERATED_AT_TEXT,
    }
    assert clock.calls == 1
    assert parse_event(event.body, HEALTH_ASSESSMENT_GENERATED).subject == REQUEST_ID


# Modele görselsiz, rehberli talimat, görev metni ve değerlendirme şemasıyla gidilir.
async def test_llm_receives_text_only_request_with_prompt_and_schema() -> None:
    llm = FakeLlm(VALID_OUTPUT)
    event = requested_event()

    await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    [call] = llm.calls
    system_prompt, task_text = expected_prompts(event)
    assert call.system_prompt == system_prompt
    assert call.user_text == task_text
    assert call.image_data_urls == ()
    assert call.schema_name == ASSESSMENT_SCHEMA_NAME
    assert call.schema is ASSESSMENT_SCHEMA
    assert call.follow_up == ()
    assert "Anemi bulgusu:" in call.system_prompt
    assert "Aşı takvimi:" in call.system_prompt
    assert '"trend": "azalıyor"' in call.user_text
    assert '"status": "gecikmiş"' in call.user_text


# Tetiklenen rehber yoksa talimatta rehber olmadığı yazılır.
async def test_no_triggered_pattern_reaches_system_prompt() -> None:
    llm = FakeLlm(EMPTY_OUTPUT)
    event = requested_event(lab_series=[], vaccinations=[])

    await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    [call] = llm.calls
    assert call.system_prompt.endswith(
        "\n\nKonuya özel rehberler:\n- Bu değerlendirme için tetiklenen rehber yok."
    )


# Tetiklenen rehberler analiz ve türe göre seçilir.
def test_expected_patterns_for_default_request() -> None:
    data = cast(events_pb2.HealthAssessmentRequested, requested_event().data)

    patterns = triggered_patterns(
        analyze(data, AS_OF, critical_deviation_percent=CRITICAL_PERCENT), "DOG"
    )

    assert [pattern.id for pattern in patterns] == [ANEMIA, VACCINATION]


# Kritik sapma eşiği analize verilir; kritik bulguda düşük risk düzeltme ister.
async def test_critical_threshold_drives_risk_floor() -> None:
    llm = FakeLlm(VALID_OUTPUT, output_text(riskLevel="HIGH"))
    publisher = FakePublisher()
    event = requested_event()

    await make_pipeline(llm, critical_percent=10).handle(
        event, cast(Publisher, publisher)
    )

    first, second = llm.calls
    assert first.user_text == expected_prompts(event, 10)[1]
    assert '"critical": true' in first.user_text
    assert second.follow_up == (
        ChatTurn("assistant", VALID_OUTPUT),
        ChatTurn(
            "user",
            build_assessment_correction_text(
                [ValidationIssue("riskLevel", "RISK_FLOOR")]
            ),
        ),
    )
    data = envelope_of(publisher.events[0])["data"]
    assert data["assessment"]["riskLevel"] == "HEALTH_RISK_HIGH"


# Eşik sapmanın altındaysa bulgu kritik sayılmaz ve düşük risk kabul edilir.
async def test_non_critical_finding_accepts_moderate_risk() -> None:
    llm = FakeLlm(VALID_OUTPUT)

    await make_pipeline(llm, critical_percent=11.2).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [call] = llm.calls
    assert '"critical": true' not in call.user_text


# Her riskLevel, likelihood ve category kısa adı doğru proto değerine çevrilir.
@pytest.mark.parametrize(
    ("risk", "likelihood", "category", "expected"),
    [
        (
            "LOW",
            "LOW",
            "NUTRITION",
            ("HEALTH_RISK_LOW", "CONDITION_LIKELIHOOD_LOW", "RECOMMENDATION_NUTRITION"),
        ),
        (
            "MODERATE",
            "MEDIUM",
            "CARE",
            (
                "HEALTH_RISK_MODERATE",
                "CONDITION_LIKELIHOOD_MEDIUM",
                "RECOMMENDATION_CARE",
            ),
        ),
        (
            "HIGH",
            "HIGH",
            "FOLLOW_UP_TEST",
            (
                "HEALTH_RISK_HIGH",
                "CONDITION_LIKELIHOOD_HIGH",
                "RECOMMENDATION_FOLLOW_UP_TEST",
            ),
        ),
        (
            "URGENT",
            "HIGH",
            "VET_VISIT",
            (
                "HEALTH_RISK_URGENT",
                "CONDITION_LIKELIHOOD_HIGH",
                "RECOMMENDATION_VET_VISIT",
            ),
        ),
    ],
)
async def test_enum_mappings(
    risk: str, likelihood: str, category: str, expected: tuple[str, str, str]
) -> None:
    publisher = FakePublisher()
    conditions = copy.deepcopy(VALID_OUTPUT_DATA["possibleConditions"])
    conditions[0]["likelihood"] = likelihood
    output = output_text(
        riskLevel=risk,
        possibleConditions=conditions,
        recommendations=[{"category": category, "text": "Öneri"}],
    )

    await make_pipeline(FakeLlm(output)).handle(
        requested_event(), cast(Publisher, publisher)
    )

    assessment = envelope_of(publisher.events[0])["data"]["assessment"]
    assert (
        assessment["riskLevel"],
        assessment["possibleConditions"][0]["likelihood"],
        assessment["recommendations"][0]["category"],
    ) == expected


# Eşleme tabloları doğrulayıcının seçenekleriyle ve proto değerleriyle aynıdır.
def test_mapping_tables_cover_validator_options() -> None:
    assert tuple(RISK_LEVEL_VALUES) == validate.RISK_LEVELS
    assert tuple(LIKELIHOOD_VALUES) == validate.LIKELIHOODS
    assert tuple(CATEGORY_VALUES) == validate.CATEGORIES
    assert set(RISK_LEVEL_VALUES.values()) == set(
        medical_record_pb2.HealthRiskLevel.values()
    ) - {medical_record_pb2.HEALTH_RISK_LEVEL_UNSPECIFIED}
    assert set(LIKELIHOOD_VALUES.values()) == set(
        medical_record_pb2.ConditionLikelihood.values()
    ) - {medical_record_pb2.CONDITION_LIKELIHOOD_UNSPECIFIED}
    assert set(CATEGORY_VALUES.values()) == set(
        medical_record_pb2.RecommendationCategory.values()
    ) - {medical_record_pb2.RECOMMENDATION_CATEGORY_UNSPECIFIED}


# Boş listeli çıktı yalnızca özet, risk ve kodun hesapladığı hatırlatmayla yayınlanır.
async def test_empty_lists_keep_code_reminders() -> None:
    publisher = FakePublisher()

    await make_pipeline(FakeLlm(EMPTY_OUTPUT)).handle(
        requested_event(), cast(Publisher, publisher)
    )

    assessment = envelope_of(publisher.events[0])["data"]["assessment"]
    assert assessment == {
        "summary": EXPECTED_ASSESSMENT["summary"],
        "riskLevel": "HEALTH_RISK_HIGH",
        "vaccinationReminders": EXPECTED_ASSESSMENT["vaccinationReminders"],
        "questionsForVet": EXPECTED_ASSESSMENT["questionsForVet"],
    }


# Yayınlanan olayda doğrulanmış, kırpılmış metin ve kırpılmış güven skoru kullanılır.
async def test_generated_uses_validated_result() -> None:
    publisher = FakePublisher()
    output = output_text(
        confidence=1.7,
        summary="  Özet\n",
        findings=[{"testName": " HCT ", "interpretation": " Yorum ", "x": 1}],
        extra=SECRET_MARKER,
    )

    await make_pipeline(FakeLlm(output)).handle(
        requested_event(), cast(Publisher, publisher)
    )

    data = envelope_of(publisher.events[0])["data"]
    assert data["confidence"] == 1.0
    assert data["assessment"]["summary"] == "Özet"
    assert data["assessment"]["findings"] == [
        {"testName": "HCT", "trend": "LAB_TREND_FALLING", "interpretation": "Yorum"}
    ]
    assert SECRET_MARKER not in json.dumps(data["assessment"]["findings"])


# Kırpılmış adla gelen seri modelin kırpılmış adıyla eşlenir ve eğilimi bulunur.
async def test_trimmed_series_names_match_findings() -> None:
    publisher = FakePublisher()
    event = requested_event(
        lab_series=[
            series(" HCT\n", measurement("2026-09-01", "30"), measurement(value="40")),
            series("HGB"),
        ]
    )

    await make_pipeline(FakeLlm(VALID_OUTPUT)).handle(event, cast(Publisher, publisher))

    findings = envelope_of(publisher.events[0])["data"]["assessment"]["findings"]
    assert [(item["testName"], item["trend"]) for item in findings] == [
        ("HGB", "LAB_TREND_SINGLE"),
        ("HCT", "LAB_TREND_RISING"),
    ]


# Modelin istekte olmayan test adı vermesi düzeltme ister.
async def test_unknown_test_name_needs_correction() -> None:
    llm = FakeLlm(VALID_OUTPUT, EMPTY_OUTPUT)
    event = requested_event(lab_series=[series("WBC")])

    await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    second = llm.calls[1]
    correction = second.follow_up[1].text
    assert "- findings[0].testName: ENUM" in correction
    assert "- possibleConditions[0].evidence[0]: ENUM" in correction


# Varsayılan saatin milisaniyeli, Z ile biten şimdiki UTC zamanı verdiğini doğrular.
async def test_default_clock_uses_current_utc_time() -> None:
    publisher = FakePublisher()
    pipeline = make_pipeline(FakeLlm(VALID_OUTPUT))
    before = datetime.now(UTC).replace(microsecond=0)

    await pipeline.handle(requested_event(), cast(Publisher, publisher))
    failure = pipeline.build_failure(requested_event(), INVALID_AI_OUTPUT)

    after = datetime.now(UTC)
    texts = [
        envelope_of(publisher.events[0])["data"]["generatedAt"],
        envelope_of(failure)["data"]["failedAt"],
    ]
    for text in texts:
        assert TIME_PATTERN.fullmatch(text)
        assert before <= datetime.fromisoformat(text) <= after


# İlk çıktı geçersiz, ikincisi geçerliyse düzeltmeyle generated yayınlandığını doğrular.
@pytest.mark.parametrize(
    "first_output",
    [
        pytest.param(INVALID_OUTPUT, id="kural-disi"),
        pytest.param(NOT_JSON_OUTPUT, id="json-degil"),
    ],
)
async def test_invalid_then_valid_output_sends_correction(first_output: str) -> None:
    llm = FakeLlm(first_output, VALID_OUTPUT)
    publisher = FakePublisher()

    await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    first, second = llm.calls
    assert first.follow_up == ()
    assert second.follow_up == (
        ChatTurn("assistant", first_output),
        ChatTurn("user", build_assessment_correction_text(issues_of(first_output))),
    )
    assert dataclasses.replace(second, follow_up=()) == first
    assert [event.type for event in publisher.events] == [HEALTH_ASSESSMENT_GENERATED]
    data = envelope_of(publisher.events[0])["data"]
    assert data["assessment"] == EXPECTED_ASSESSMENT


# İlk yanıt yarımsa aynı isteğin düz olarak bir kez tekrarlandığını doğrular.
async def test_incomplete_then_valid_output_repeats_same_request() -> None:
    llm = FakeLlm(IncompleteOutputError("yarım"), VALID_OUTPUT)
    publisher = FakePublisher()

    await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    first, second = llm.calls
    assert second == first
    assert second.follow_up == ()
    assert [event.type for event in publisher.events] == [HEALTH_ASSESSMENT_GENERATED]


# İkinci deneme de bozuksa INVALID_AI_OUTPUT verildiğini, 3. çağrı olmadığını doğrular.
@pytest.mark.parametrize(
    ("first_outcome", "second_outcome"),
    [
        pytest.param(INVALID_OUTPUT, INVALID_OUTPUT, id="gecersiz-gecersiz"),
        pytest.param(NOT_JSON_OUTPUT, NOT_JSON_OUTPUT, id="json-degil-json-degil"),
        pytest.param(
            INVALID_OUTPUT, IncompleteOutputError("yarım"), id="gecersiz-yarim"
        ),
        pytest.param(
            IncompleteOutputError("yarım"),
            IncompleteOutputError("yarım"),
            id="yarim-yarim",
        ),
        pytest.param(
            IncompleteOutputError("yarım"), INVALID_OUTPUT, id="yarim-gecersiz"
        ),
    ],
)
async def test_second_failure_raises_invalid_ai_output(
    first_outcome: str | BaseException, second_outcome: str | BaseException
) -> None:
    llm = FakeLlm(first_outcome, second_outcome, VALID_OUTPUT)
    publisher = FakePublisher()

    with pytest.raises(PermanentError) as raised:
        await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    assert raised.value.code == INVALID_AI_OUTPUT
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__
    assert len(llm.calls) == 2
    assert publisher.events == []


LLM_ERRORS = [
    pytest.param(PermanentError, AI_PROVIDER_REJECTED, id="reddedildi"),
    pytest.param(TransientError, "AI API gecici hata", id="gecici"),
    pytest.param(UnexpectedStatusError, 418, id="beklenmeyen-durum"),
]


# İlk model çağrısındaki istemci hatalarının olduğu gibi yükseldiğini doğrular.
@pytest.mark.parametrize(("error_type", "argument"), LLM_ERRORS)
async def test_llm_errors_on_first_call_propagate(
    error_type: type[Exception], argument: object
) -> None:
    error = error_type(argument)
    llm = FakeLlm(error, VALID_OUTPUT)
    publisher = FakePublisher()

    with pytest.raises(error_type) as raised:
        await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert len(llm.calls) == 1
    assert publisher.events == []


# İkinci çağrıdaki istemci hatalarının INVALID_AI_OUTPUT'a çevrilmediğini doğrular.
@pytest.mark.parametrize(("error_type", "argument"), LLM_ERRORS)
@pytest.mark.parametrize(
    "first_outcome",
    [
        pytest.param(INVALID_OUTPUT, id="gecersizden-sonra"),
        pytest.param(IncompleteOutputError("yarım"), id="yarimdan-sonra"),
    ],
)
async def test_llm_errors_on_second_call_propagate(
    first_outcome: str | BaseException, error_type: type[Exception], argument: object
) -> None:
    error = error_type(argument)
    llm = FakeLlm(first_outcome, error, VALID_OUTPUT)
    publisher = FakePublisher()

    with pytest.raises(error_type) as raised:
        await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert len(llm.calls) == 2
    assert publisher.events == []


# generated olayı yayınlanamazsa yayın hatasının olduğu gibi yükseldiğini doğrular.
async def test_publish_failure_propagates() -> None:
    error = PublishError(UNROUTABLE)
    publisher = FakePublisher(error)
    llm = FakeLlm(VALID_OUTPUT)

    with pytest.raises(PublishError) as raised:
        await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert len(llm.calls) == 1


INVALID_INPUTS = [
    pytest.param({"as_of": ""}, id="tarih-bos"),
    pytest.param({"as_of": "21.10.2026"}, id="tarih-turkce-bicim"),
    pytest.param({"as_of": "2026-02-30"}, id="tarih-30-subat"),
    pytest.param({"as_of": " 2026-10-21"}, id="tarih-bosluklu"),
    pytest.param({"birth_date": "bilinmiyor"}, id="dogum-metin"),
    pytest.param({"birth_date": " "}, id="dogum-bosluk"),
    pytest.param({"species": "D" * 33}, id="tur-33"),
    pytest.param({"species": "DO\nG"}, id="tur-satir-sonu"),
    pytest.param({"breed": "b" * 33}, id="irk-33"),
    pytest.param({"breed": "Gol\tden"}, id="irk-sekme"),
    pytest.param({"sex": "s" * 33}, id="cinsiyet-33"),
    pytest.param({"sex": "FE" + chr(0) + "MALE"}, id="cinsiyet-nul"),
    pytest.param(
        {
            "lab_series": [],
            "vaccinations": [],
            "prescriptions": [],
            "clinical_notes": [],
        },
        id="kayit-yok",
    ),
    pytest.param(
        {"lab_series": [series(f"T{index}") for index in range(61)]}, id="seri-61"
    ),
    pytest.param({"lab_series": [series("")]}, id="test-adi-bos"),
    pytest.param({"lab_series": [series("  ")]}, id="test-adi-bosluk"),
    pytest.param({"lab_series": [series("a" * 129)]}, id="test-adi-129"),
    pytest.param({"lab_series": [series("HC\nT")]}, id="test-adi-satir-sonu"),
    pytest.param(
        {"lab_series": [series("HCT"), series(" HCT ")]}, id="test-adi-tekrar"
    ),
    pytest.param(
        {"lab_series": [events_pb2.LabSeries(test_name="HCT")]}, id="olcum-yok"
    ),
    pytest.param(
        {"lab_series": [series("HCT", *(measurement() for _ in range(7)))]},
        id="olcum-7",
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(sampled_at=""))]}, id="olcum-tarih"
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(value=""))]}, id="deger-bos"
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(value="1" * 65))]}, id="deger-65"
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(value="1\t2"))]}, id="deger-sekme"
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(unit="u" * 33))]}, id="birim-33"
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(reference_range="1" * 65))]},
        id="aralik-65",
    ),
    pytest.param(
        {"lab_series": [series("HCT", measurement(reference_range="1-\n2"))]},
        id="aralik-satir-sonu",
    ),
    pytest.param({"lab_series": [series("HCT", measurement(flag=7))]}, id="flag-7"),
    pytest.param(
        {"lab_series": [*default_series(), series("Glukoz", measurement(value=""))]},
        id="son-seri-gecersiz",
    ),
    pytest.param({"vaccinations": [vaccination()] * 21}, id="asi-21"),
    pytest.param({"vaccinations": [vaccination(vaccine_name="")]}, id="asi-adi-bos"),
    pytest.param(
        {"vaccinations": [vaccination(vaccine_name="a" * 129)]}, id="asi-adi-129"
    ),
    pytest.param(
        {"vaccinations": [vaccination(administered_at="")]}, id="asi-tarihi-bos"
    ),
    pytest.param(
        {"vaccinations": [vaccination(next_due_at="2026-13-01")]},
        id="sonraki-tarih-gecersiz",
    ),
    pytest.param(
        {"vaccinations": [vaccination(batch_number="1" * 65)]}, id="seri-no-65"
    ),
    pytest.param({"prescriptions": [prescription()] * 21}, id="recete-21"),
    pytest.param(
        {"prescriptions": [prescription(medication_name="")]}, id="ilac-adi-bos"
    ),
    pytest.param(
        {"prescriptions": [prescription(medication_name="a" * 129)]},
        id="ilac-adi-129",
    ),
    pytest.param({"prescriptions": [prescription(dosage="d" * 65)]}, id="doz-65"),
    pytest.param(
        {"prescriptions": [prescription(frequency="f\nx")]}, id="siklik-satir-sonu"
    ),
    pytest.param({"prescriptions": [prescription(frequency="f" * 65)]}, id="siklik-65"),
    pytest.param({"prescriptions": [prescription(duration_days=-1)]}, id="sure-eksi"),
    pytest.param({"prescriptions": [prescription(duration_days=3651)]}, id="sure-3651"),
    pytest.param(
        {"prescriptions": [prescription(instructions="i" * 1001)]}, id="talimat-1001"
    ),
    pytest.param(
        {"prescriptions": [prescription(instructions="a\tb")]}, id="talimat-sekme"
    ),
    pytest.param(
        {"prescriptions": [prescription(prescribed_at="")]}, id="recete-tarihi-bos"
    ),
    pytest.param({"clinical_notes": [note()] * 21}, id="not-21"),
    pytest.param(
        {"clinical_notes": [note(type=medical_record_pb2.RECORD_TYPE_UNSPECIFIED)]},
        id="not-turu-belirsiz",
    ),
    pytest.param(
        {"clinical_notes": [note(type=medical_record_pb2.LAB_RESULT)]},
        id="not-turu-tahlil",
    ),
    pytest.param(
        {"clinical_notes": [note(type=medical_record_pb2.VACCINATION)]},
        id="not-turu-asi",
    ),
    pytest.param({"clinical_notes": [note(title="a")]}, id="not-baslik-1"),
    pytest.param({"clinical_notes": [note(title="a" * 129)]}, id="not-baslik-129"),
    pytest.param({"clinical_notes": [note(title="Ge\nnel")]}, id="not-baslik-satir"),
    pytest.param({"clinical_notes": [note(notes="n" * 1001)]}, id="not-1001"),
    pytest.param({"clinical_notes": [note(notes="a" + chr(0x7F))]}, id="not-del"),
    pytest.param({"clinical_notes": [note(recorded_at="")]}, id="not-tarihi-bos"),
]


# Geçersiz girdinin model çağrılmadan ve yayın yapılmadan INVALID_DATA verdiğini sınar.
@pytest.mark.parametrize("changes", INVALID_INPUTS)
async def test_invalid_input_is_invalid_message(changes: dict[str, Any]) -> None:
    llm = FakeLlm(EMPTY_OUTPUT)
    publisher = FakePublisher()

    with pytest.raises(InvalidMessageError) as raised:
        await make_pipeline(llm).handle(
            requested_event(**changes), cast(Publisher, publisher)
        )

    assert raised.value.reason == "INVALID_DATA"
    assert llm.calls == []
    assert publisher.events == []


# Verisi HealthAssessmentRequested olmayan olayın geçersiz mesaj sayıldığını doğrular.
async def test_non_requested_data_is_invalid_message() -> None:
    llm = FakeLlm(VALID_OUTPUT)
    event = dataclasses.replace(
        requested_event(),
        type=DOCUMENT_UPLOADED,
        data=events_pb2.DocumentUploaded(document_id=REQUEST_ID),
    )

    with pytest.raises(InvalidMessageError) as raised:
        await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    assert raised.value.reason == "INVALID_DATA"
    assert llm.calls == []


VALID_INPUTS = [
    pytest.param(
        {"vaccinations": [], "prescriptions": [], "clinical_notes": []},
        id="yalniz-tahlil",
    ),
    pytest.param(
        {"lab_series": [], "prescriptions": [], "clinical_notes": []},
        id="yalniz-asi",
    ),
    pytest.param(
        {"lab_series": [], "vaccinations": [], "clinical_notes": []},
        id="yalniz-recete",
    ),
    pytest.param(
        {"lab_series": [], "vaccinations": [], "prescriptions": []},
        id="yalniz-not",
    ),
    pytest.param({"birth_date": ""}, id="dogum-bos"),
    pytest.param({"birth_date": "2026-10-22"}, id="dogum-sonra"),
    pytest.param({"species": "", "breed": "", "sex": ""}, id="profil-bos"),
    pytest.param(
        {"species": "LIZARD", "breed": "ş" * 32, "sex": "UNKNOWN"},
        id="profil-serbest",
    ),
    pytest.param({"breed": "\n Golden \t"}, id="irk-kenar-bosluklari"),
    pytest.param(
        {"lab_series": [series(f"T{index}") for index in range(60)]}, id="seri-60"
    ),
    pytest.param(
        {"lab_series": [series("HCT", *(measurement() for _ in range(6)))]},
        id="olcum-6",
    ),
    pytest.param({"lab_series": [series("HCT"), series("hct")]}, id="buyuk-kucuk"),
    pytest.param(
        {
            "lab_series": [
                series(
                    "ş" * 128,
                    measurement(
                        value="1" * 64, unit="u" * 32, reference_range="r" * 64
                    ),
                )
            ]
        },
        id="seri-ust-sinirlar",
    ),
    *(
        pytest.param(
            {"lab_series": [series("HCT", measurement(flag=flag))]}, id=f"flag-{name}"
        )
        for name, flag in medical_record_pb2.LabResultFlag.items()
    ),
    pytest.param({"vaccinations": [vaccination()] * 20}, id="asi-20"),
    pytest.param(
        {
            "vaccinations": [
                vaccination(
                    vaccine_name="a" * 128, next_due_at="", batch_number="1" * 64
                )
            ]
        },
        id="asi-ust-sinirlar",
    ),
    pytest.param({"vaccinations": [vaccination(batch_number="")]}, id="seri-no-bos"),
    pytest.param({"prescriptions": [prescription()] * 20}, id="recete-20"),
    pytest.param(
        {
            "prescriptions": [
                prescription(
                    medication_name="a" * 128,
                    dosage="",
                    frequency="",
                    duration_days=0,
                    instructions="",
                )
            ]
        },
        id="recete-alt-sinirlar",
    ),
    pytest.param(
        {
            "prescriptions": [
                prescription(
                    dosage="d" * 64,
                    frequency="f" * 64,
                    duration_days=3650,
                    instructions="Sabah\r\n" + "i" * 993,
                )
            ]
        },
        id="recete-ust-sinirlar",
    ),
    pytest.param({"clinical_notes": [note()] * 20}, id="not-20"),
    pytest.param(
        {"clinical_notes": [note(type=medical_record_pb2.SURGERY, title="ab")]},
        id="ameliyat-kisa-baslik",
    ),
    pytest.param(
        {"clinical_notes": [note(title="ş" * 128, notes="Satır\n" + "n" * 994)]},
        id="not-ust-sinirlar",
    ),
    pytest.param({"clinical_notes": [note(notes="")]}, id="not-bos"),
]


# Sınırdaki ve isteğe bağlı alanları boş girdilerin kabul edildiğini doğrular.
@pytest.mark.parametrize("changes", VALID_INPUTS)
async def test_valid_inputs_are_accepted(changes: dict[str, Any]) -> None:
    llm = FakeLlm(EMPTY_OUTPUT)
    publisher = FakePublisher()
    event = requested_event(**changes)

    await make_pipeline(llm).handle(event, cast(Publisher, publisher))

    [call] = llm.calls
    assert (call.system_prompt, call.user_text) == expected_prompts(event)
    assert [event.type for event in publisher.events] == [HEALTH_ASSESSMENT_GENERATED]


# build_failure'ın akış kodları için doğru mesaj ve data alanları ürettiğini doğrular.
@pytest.mark.parametrize("code", FLOW_CODES)
def test_build_failure_for_flow_codes(code: str) -> None:
    llm = FakeLlm()
    pipeline = make_pipeline(llm, FakeClock(FAILED_AT))

    failure = pipeline.build_failure(requested_event(), code)

    envelope = envelope_of(failure)
    assert failure.type == HEALTH_ASSESSMENT_FAILED
    assert failure.subject == REQUEST_ID
    assert envelope["type"] == HEALTH_ASSESSMENT_FAILED
    assert envelope["subject"] == REQUEST_ID
    assert envelope["time"] == FAILED_AT_TEXT
    assert envelope["data"] == {
        "requestId": REQUEST_ID,
        "modelVersion": MODEL_VERSION,
        "errorCode": code,
        "errorMessage": EXPLANATION_ERROR_MESSAGES[code],
        "failedAt": FAILED_AT_TEXT,
    }
    assert parse_event(failure.body, HEALTH_ASSESSMENT_FAILED).subject == REQUEST_ID
    assert llm.calls == []


# build_failure, verisi HealthAssessmentRequested olmayan olayda geçersiz mesaj verir.
def test_build_failure_rejects_non_requested_data() -> None:
    event = dataclasses.replace(
        requested_event(), data=events_pb2.DocumentUploaded(document_id=REQUEST_ID)
    )

    with pytest.raises(InvalidMessageError):
        make_pipeline(FakeLlm()).build_failure(event, INVALID_AI_OUTPUT)


# Başarıda requestId, süre ve model alanlı tek bir info logu yazıldığını doğrular.
async def test_success_logs_info_with_allowed_fields(
    caplog: pytest.LogCaptureFixture,
) -> None:
    await make_pipeline(FakeLlm(VALID_OUTPUT)).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [record] = pipeline_records(caplog, logging.INFO)
    fields = vars(record)
    assert record.getMessage() == SUCCESS_MESSAGE
    assert fields["requestId"] == REQUEST_ID
    assert fields["model"] == FAKE_MODEL
    assert isinstance(fields["durationMs"], int)
    assert fields["durationMs"] >= 0
    assert pipeline_records(caplog, logging.WARNING) == []
    assert_pipeline_fields(caplog)


# Düzeltme warn logunda sorun sayısının olduğunu, alan ve değerin olmadığını doğrular.
async def test_correction_logs_warning_with_issue_count(
    caplog: pytest.LogCaptureFixture,
) -> None:
    issue_count = len(issues_of(INVALID_OUTPUT))

    await make_pipeline(FakeLlm(INVALID_OUTPUT, VALID_OUTPUT)).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [record] = pipeline_records(caplog, logging.WARNING)
    assert issue_count == 3
    assert record.getMessage() == (
        f"Model çıktısı doğrulanamadı ({issue_count} sorun), düzeltme isteniyor"
    )
    assert vars(record)["requestId"] == REQUEST_ID
    assert "summary" not in record.getMessage()
    assert_pipeline_fields(caplog)


# Yarım yanıtın tekrarında requestId'li bir warn logu yazıldığını doğrular.
async def test_incomplete_retry_logs_warning(caplog: pytest.LogCaptureFixture) -> None:
    await make_pipeline(FakeLlm(IncompleteOutputError("yarım"), VALID_OUTPUT)).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [record] = pipeline_records(caplog, logging.WARNING)
    assert record.getMessage() == INCOMPLETE_MESSAGE
    assert vars(record)["requestId"] == REQUEST_ID
    assert_pipeline_fields(caplog)


# Hata yollarında başarı logu yazılmadığını doğrular.
async def test_failure_does_not_log_success(caplog: pytest.LogCaptureFixture) -> None:
    with pytest.raises(PermanentError):
        await make_pipeline(FakeLlm(INVALID_OUTPUT, INVALID_OUTPUT)).handle(
            requested_event(), cast(Publisher, FakePublisher())
        )

    assert pipeline_records(caplog, logging.INFO) == []


# Kayıt içerikleri, model çıktısı, rehber ve sorun alanlarının loglanmadığını doğrular.
async def test_logs_never_contain_content_or_model_output(
    caplog: pytest.LogCaptureFixture,
) -> None:
    event = requested_event(
        lab_series=[series(SECRET_MARKER, measurement(value=f"{SECRET_MARKER}-1"))],
        clinical_notes=[note(notes=f"Not {SECRET_MARKER}")],
        vaccinations=[vaccination(vaccine_name=SECRET_MARKER)],
    )
    corrected_output = output_text(
        findings=[{"testName": SECRET_MARKER, "interpretation": "Yorum"}],
        possibleConditions=[],
    )
    publisher = FakePublisher()

    await make_pipeline(FakeLlm(INVALID_OUTPUT, corrected_output)).handle(
        event, cast(Publisher, publisher)
    )
    with pytest.raises(PermanentError):
        await make_pipeline(FakeLlm(NOT_JSON_OUTPUT, INVALID_OUTPUT)).handle(
            event, cast(Publisher, publisher)
        )

    assert SECRET_MARKER in publisher.events[0].body.decode("utf-8")
    assert len(pipeline_records(caplog, logging.WARNING)) == 2
    assert_not_logged(
        caplog,
        SECRET_MARKER,
        "findings[0].testName",
        "summary",
        "köpek",
        "Aşı takvimi",
        VACCINATION,
        "halsizlik",
    )
    assert_pipeline_fields(caplog)
