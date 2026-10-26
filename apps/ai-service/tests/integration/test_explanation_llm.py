import json
import logging
from typing import Any, cast

import pytest

from app.config import Settings
from app.errors import PermanentError, TransientError
from app.explanations.pipeline import ExplanationPipeline
from app.generated import events_pb2
from app.llm.client import LlmClient, UnexpectedStatusError, create_llm_client
from app.messaging.cloudevents import (
    DATASCHEMAS,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_REQUESTED,
    OutgoingEvent,
    parse_event,
)
from app.messaging.publisher import Publisher

pytestmark = pytest.mark.integration

LLM_LOGGER = "LlmClient"
PIPELINE_LOGGER = "ExplanationPipeline"
QUIET_LOGGERS = ("httpx", "httpcore")
MAX_MODEL_REQUESTS = 2
RECORD_ID = "3c9a7e51-2b4d-4f6a-8e1c-5d7b9a0f2e48"
REQUEST_TEST_NAMES = frozenset({"ALT", "Kreatinin"})
RESPONSE_FIELDS = ("statusCode", "promptTokens", "completionTokens", "durationMs")
CLIENT_FAILURES = (PermanentError, TransientError, UnexpectedStatusError)
SYNTHETIC_REQUEST: dict[str, Any] = {
    "specversion": "1.0",
    "id": "9d2f4b6a-1c3e-4a5b-9c7d-0e1f2a3b4c5d",
    "source": "/patipasaport/medical-record",
    "type": LAB_EXPLANATION_REQUESTED,
    "subject": RECORD_ID,
    "time": "2026-10-21T09:30:00.000Z",
    "datacontenttype": "application/json",
    "dataschema": DATASCHEMAS[LAB_EXPLANATION_REQUESTED],
    "data": {
        "recordId": RECORD_ID,
        "title": "Biyokimya paneli",
        "sampledAt": "2026-10-20",
        "species": "CAT",
        "birthDate": "2019-05-01",
        "isBirthDateEstimated": True,
        "items": [
            {
                "testName": "ALT",
                "value": "142",
                "unit": "U/L",
                "referenceRange": "12-130",
                "flag": "HIGH",
            },
            {
                "testName": "Kreatinin",
                "value": "1.4",
                "unit": "mg/dL",
                "referenceRange": "0.8-2.4",
                "flag": "NORMAL",
            },
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
async def explain(client: LlmClient, ai_model: str) -> tuple[list[OutgoingEvent], str]:
    event = parse_event(
        json.dumps(SYNTHETIC_REQUEST).encode("utf-8"), LAB_EXPLANATION_REQUESTED
    )
    publisher = CollectingPublisher()
    try:
        await ExplanationPipeline(client, ai_model).handle(
            event, cast(Publisher, publisher)
        )
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


# Gerçek API'nin açıklama talimatı, şeması ve doğrulayıcısıyla sentetik tahlili sınar.
async def test_explanation_prompt_schema_and_validator_work_with_provider(
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
        events, problem = await explain(client, settings.ai_model)
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
    generated = parse_event(published.body, LAB_EXPLANATION_GENERATED).data
    assert isinstance(generated, events_pb2.LabExplanationGenerated)
    names = [item.test_name for item in generated.explanation.items]
    if (
        "ALT" not in names
        or not set(names) <= REQUEST_TEST_NAMES
        or len(names) != len(set(names))
    ):
        pytest.fail(f"Beklenmeyen açıklama kalemleri: {names}", pytrace=False)
    assert generated.record_id == RECORD_ID
    assert generated.model_version == f"{settings.ai_model}/explain-v1"
    assert 0.0 <= generated.confidence <= 1.0
    assert len(successes) == 1
