import json
import logging
from typing import Any, cast

import pytest

from app.assessments.pipeline import AssessmentPipeline
from app.assessments.validate import has_dose_expression
from app.config import Settings
from app.errors import PermanentError, TransientError
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import LlmClient, UnexpectedStatusError, create_llm_client
from app.messaging.cloudevents import (
    DATASCHEMAS,
    HEALTH_ASSESSMENT_GENERATED,
    HEALTH_ASSESSMENT_REQUESTED,
    OutgoingEvent,
    parse_event,
)
from app.messaging.publisher import Publisher

pytestmark = pytest.mark.integration

LLM_LOGGER = "LlmClient"
PIPELINE_LOGGER = "AssessmentPipeline"
QUIET_LOGGERS = ("httpx", "httpcore")
MAX_MODEL_REQUESTS = 2
REQUEST_ID = "5b7d9f1a-3c5e-4a7b-8d9f-1b3d5f7a9c2e"
REQUEST_TEST_NAMES = frozenset({"HCT", "HGB"})
RESPONSE_FIELDS = ("statusCode", "promptTokens", "completionTokens", "durationMs")
CLIENT_FAILURES = (PermanentError, TransientError, UnexpectedStatusError)
VALID_RISK_LEVELS = frozenset(medical_record_pb2.HealthRiskLevel.values()) - {
    medical_record_pb2.HEALTH_RISK_LEVEL_UNSPECIFIED
}
SYNTHETIC_REQUEST: dict[str, Any] = {
    "specversion": "1.0",
    "id": "2d4f6a8c-0e1b-4d3f-a5c7-9e1b3d5f7a9c",
    "source": "/patipasaport/medical-record",
    "type": HEALTH_ASSESSMENT_REQUESTED,
    "subject": REQUEST_ID,
    "time": "2026-10-21T09:30:00.000Z",
    "datacontenttype": "application/json",
    "dataschema": DATASCHEMAS[HEALTH_ASSESSMENT_REQUESTED],
    "data": {
        "requestId": REQUEST_ID,
        "asOf": "2026-10-21",
        "species": "DOG",
        "breed": "",
        "sex": "FEMALE",
        "isNeutered": True,
        "birthDate": "2023-10-01",
        "isBirthDateEstimated": False,
        "labSeries": [
            {
                "testName": "HCT",
                "measurements": [
                    {
                        "sampledAt": "2026-06-01",
                        "value": "40",
                        "unit": "%",
                        "referenceRange": "37-55",
                        "flag": "NORMAL",
                    },
                    {
                        "sampledAt": "2026-08-01",
                        "value": "36",
                        "unit": "%",
                        "referenceRange": "37-55",
                        "flag": "LOW",
                    },
                    {
                        "sampledAt": "2026-10-01",
                        "value": "33",
                        "unit": "%",
                        "referenceRange": "37-55",
                        "flag": "LOW",
                    },
                ],
            },
            {
                "testName": "HGB",
                "measurements": [
                    {
                        "sampledAt": "2026-10-01",
                        "value": "14",
                        "unit": "g/dL",
                        "referenceRange": "12-18",
                        "flag": "NORMAL",
                    }
                ],
            },
        ],
        "vaccinations": [
            {
                "vaccineName": "Kuduz",
                "batchNumber": "",
                "administeredAt": "2025-09-01",
                "nextDueAt": "2026-09-01",
            }
        ],
        "clinicalNotes": [
            {
                "type": "EXAMINATION",
                "title": "Genel muayene",
                "notes": "Son haftalarda halsizlik bildirildi.",
                "recordedAt": "2026-10-01",
            }
        ],
    },
}


class CollectingPublisher:
    # Yayınlanan olayları RabbitMQ'ya gitmeden bellekte toplayan yayıncıyı kurar.
    def __init__(self) -> None:
        self.events: list[OutgoingEvent] = []

    # Olayı kaydeder.
    async def publish(self, event: OutgoingEvent) -> None:
        self.events.append(event)


# Sentetik isteği akıştan geçirir; yayınlanan olayları ya da kodlu hata metnini verir.
async def assess(
    client: LlmClient, settings: Settings
) -> tuple[list[OutgoingEvent], str]:
    event = parse_event(
        json.dumps(SYNTHETIC_REQUEST).encode("utf-8"), HEALTH_ASSESSMENT_REQUESTED
    )
    publisher = CollectingPublisher()
    pipeline = AssessmentPipeline(
        client, settings.ai_model, settings.assessment_critical_deviation_percent
    )
    try:
        await pipeline.handle(event, cast(Publisher, publisher))
    except CLIENT_FAILURES as error:
        return (
            publisher.events,
            f"Akış başarısız oldu ({type(error).__name__}: {error})",
        )
    return publisher.events, ""


# LlmClient yanıt kayıtlarından durum kodu, token ve süre alanlarını toplar.
def response_stats(caplog: pytest.LogCaptureFixture) -> list[dict[str, object]]:
    return [
        {name: getattr(record, name, None) for name in RESPONSE_FIELDS}
        for record in caplog.records
        if record.name == LLM_LOGGER and hasattr(record, "statusCode")
    ]


# Akışın verilen seviyedeki kayıtlarını döndürür.
def pipeline_records(
    caplog: pytest.LogCaptureFixture, level: int
) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == PIPELINE_LOGGER and record.levelno == level
    ]


# Değerlendirmedeki model metinlerinin hepsini sırayla toplar.
def assessment_texts(assessment: medical_record_pb2.HealthAssessment) -> list[str]:
    return [
        assessment.summary,
        *(finding.interpretation for finding in assessment.findings),
        *(condition.name for condition in assessment.possible_conditions),
        *(condition.explanation for condition in assessment.possible_conditions),
        *(item.text for item in assessment.recommendations),
        *assessment.questions_for_vet,
    ]


# Değerlendirme talimatı, şeması ve doğrulayıcısını gerçek API ile sınar.
async def test_assessment_prompt_schema_and_validator_work_with_provider(
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    record_property: Any,
) -> None:
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    caplog.set_level(logging.INFO, logger=LLM_LOGGER)
    caplog.set_level(logging.INFO, logger=PIPELINE_LOGGER)
    client = create_llm_client(settings)
    try:
        events, problem = await assess(client, settings)
    finally:
        await client.aclose()
    stats = response_stats(caplog)
    warnings = pipeline_records(caplog, logging.WARNING)
    successes = pipeline_records(caplog, logging.INFO)
    record_property("modelRequests", len(stats))
    record_property("pipelineWarnings", [record.getMessage() for record in warnings])
    record_property("responses", json.dumps(stats))
    record_property(
        "pipelineDurationMs", [getattr(r, "durationMs", None) for r in successes]
    )
    assert len(stats) <= MAX_MODEL_REQUESTS
    if problem:
        pytest.fail(f"{problem} [model istekleri: {stats}]", pytrace=False)
    [published] = events
    generated = parse_event(published.body, HEALTH_ASSESSMENT_GENERATED).data
    assert isinstance(generated, events_pb2.HealthAssessmentGenerated)
    assessment = generated.assessment
    names = [finding.test_name for finding in assessment.findings]
    evidence = [
        name
        for condition in assessment.possible_conditions
        for name in condition.evidence
    ]
    if not set(names) <= REQUEST_TEST_NAMES or not set(evidence) <= REQUEST_TEST_NAMES:
        pytest.fail(f"Beklenmeyen test adları: {names} / {evidence}", pytrace=False)
    assert generated.request_id == REQUEST_ID
    assert generated.model_version == f"{settings.ai_model}/assess-v1"
    assert 0.0 <= generated.confidence <= 1.0
    assert assessment.risk_level in VALID_RISK_LEVELS
    for finding in assessment.findings:
        if finding.test_name == "HCT":
            assert finding.trend == medical_record_pb2.LAB_TREND_FALLING
    [reminder] = assessment.vaccination_reminders
    assert (reminder.vaccine_name, reminder.next_due_at, reminder.status) == (
        "Kuduz",
        "2026-09-01",
        medical_record_pb2.VACCINATION_OVERDUE,
    )
    assert not any(has_dose_expression(text) for text in assessment_texts(assessment))
    assert len(successes) == 1
