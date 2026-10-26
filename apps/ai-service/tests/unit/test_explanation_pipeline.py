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

from app.errors import (
    AI_PROVIDER_REJECTED,
    AI_PROVIDER_UNAVAILABLE,
    EXPLANATION_ERROR_MESSAGES,
    INTERNAL_ERROR,
    INVALID_AI_OUTPUT,
    PermanentError,
    TransientError,
)
from app.explanations.pipeline import ExplanationPipeline
from app.explanations.validate import ExplanationInvalid, validate_explanation
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import (
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    LlmReply,
    UnexpectedStatusError,
)
from app.llm.prompts import (
    EXPLAIN_SYSTEM_PROMPT,
    build_explain_task_text,
    build_explanation_correction_text,
)
from app.llm.schemas import EXPLANATION_SCHEMA, EXPLANATION_SCHEMA_NAME
from app.logs import JsonFormatter
from app.messaging.cloudevents import (
    DOCUMENT_UPLOADED,
    LAB_EXPLANATION_FAILED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_REQUESTED,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    parse_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import UNROUTABLE, Publisher, PublishError
from app.messaging.topology import EXPLANATION_PREFETCH, Topology
from app.validation import ValidationIssue

RECORD_ID = "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
EVENT_ID = "0f6c1d3e-8a2b-4c5d-9e7f-1a2b3c4d5e6f"
MEDICAL_RECORD_SOURCE = "/patipasaport/medical-record"
FAKE_MODEL = "sahte-model"
MODEL_VERSION = "sahte-model/explain-v1"
EVENT_TIME = datetime(2026, 10, 21, 9, 30, tzinfo=UTC)
GENERATED_AT = datetime(
    2026, 10, 21, 12, 30, 8, 456789, tzinfo=timezone(timedelta(hours=3))
)
GENERATED_AT_TEXT = "2026-10-21T09:30:08.456Z"
FAILED_AT = datetime(2026, 10, 21, 9, 32, 30)
FAILED_AT_TEXT = "2026-10-21T09:32:30.000Z"
SECRET_MARKER = "GIZLI-TAHLIL-ICERIGI-9Z"
PIPELINE_LOGGER = "ExplanationPipeline"
PIPELINE_LOG_FIELDS = frozenset({"recordId", "durationMs", "model"})
STANDARD_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
}
TIME_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"
)
SUCCESS_MESSAGE = "Tahlil açıklaması üretildi ve yayınlandı"
INCOMPLETE_MESSAGE = "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor"
FLOW_B_CODES = (
    INVALID_AI_OUTPUT,
    AI_PROVIDER_REJECTED,
    AI_PROVIDER_UNAVAILABLE,
    INTERNAL_ERROR,
)
UNSPECIFIED = medical_record_pb2.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED

ALT_EXPLANATION = (
    f"ALT, karaciğer hücrelerinde bulunan bir enzimdir. {SECRET_MARKER} Hafif "
    "yükseklik farklı nedenlerle görülebilir."
)
VALID_OUTPUT_DATA: dict[str, Any] = {
    "confidence": 0.82,
    "summary": f"Değerlerin çoğu referans aralığında. {SECRET_MARKER}",
    "items": [{"testName": "ALT", "explanation": ALT_EXPLANATION}],
}
EXPECTED_EXPLANATION: dict[str, Any] = {
    "summary": f"Değerlerin çoğu referans aralığında. {SECRET_MARKER}",
    "items": [{"testName": "ALT", "explanation": ALT_EXPLANATION}],
}


# Geçerli açıklama çıktısını verilen değişikliklerle JSON metni olarak üretir.
def output_text(**changes: Any) -> str:
    data = copy.deepcopy(VALID_OUTPUT_DATA)
    data.update(changes)
    return json.dumps(data, ensure_ascii=False)


VALID_OUTPUT = output_text()
INVALID_OUTPUT = output_text(
    summary="",
    items=[{"testName": SECRET_MARKER, "explanation": SECRET_MARKER + chr(0)}],
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


# Verilen alanlarla bir tahlil kalemi üretir.
def lab_item(
    test_name: str,
    value: str = "1",
    unit: str = "",
    reference_range: str = "",
    flag: int = UNSPECIFIED,
) -> medical_record_pb2.LabResultItem:
    return medical_record_pb2.LabResultItem(
        test_name=test_name,
        value=value,
        unit=unit,
        reference_range=reference_range,
        flag=flag,
    )


# Sözleşme 16.1'deki kedi tahlilinin iki kalemini döndürür.
def contract_items() -> list[medical_record_pb2.LabResultItem]:
    return [
        lab_item("ALT", "142", "U/L", "12-130", medical_record_pb2.LabResultFlag.HIGH),
        lab_item(
            "Kreatinin",
            "1.4",
            "mg/dL",
            "0.8-2.4",
            medical_record_pb2.LabResultFlag.NORMAL,
        ),
    ]


# Verilen alan değişiklikleriyle geçerli bir lab_explanation.requested olayı üretir.
def requested_event(**changes: Any) -> IncomingEvent:
    fields: dict[str, Any] = {
        "record_id": RECORD_ID,
        "title": "Biyokimya paneli",
        "sampled_at": "2026-10-20",
        "species": "CAT",
        "birth_date": "2019-05-01",
        "is_birth_date_estimated": True,
        "items": contract_items(),
    }
    fields.update(changes)
    return IncomingEvent(
        id=EVENT_ID,
        type=LAB_EXPLANATION_REQUESTED,
        source=MEDICAL_RECORD_SOURCE,
        subject=RECORD_ID,
        time=EVENT_TIME,
        data=events_pb2.LabExplanationRequested(**fields),
    )


# Sahte istemciyle, istenirse sahte saati kullanan bir açıklama akışı kurar.
def make_pipeline(
    llm: FakeLlm, clock: FakeClock | None = None, ai_model: str = FAKE_MODEL
) -> ExplanationPipeline:
    if clock is None:
        return ExplanationPipeline(cast(LlmClient, llm), ai_model)
    return ExplanationPipeline(cast(LlmClient, llm), ai_model, clock=clock)


# Model çıktısının doğrulama sorunlarını validate_explanation ile hesaplar.
def issues_of(output: str) -> tuple[ValidationIssue, ...]:
    with pytest.raises(ExplanationInvalid) as raised:
        validate_explanation(output, contract_items())
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


# Akışın beklenen girdiyle ürettiği görev metnini döndürür.
def expected_task_text(event: IncomingEvent) -> str:
    data = cast(events_pb2.LabExplanationRequested, event.data)
    return build_explain_task_text(
        species=data.species,
        birth_date=date.fromisoformat(data.birth_date) if data.birth_date else None,
        birth_date_estimated=data.is_birth_date_estimated,
        title=data.title,
        sampled_at=date.fromisoformat(data.sampled_at),
        items=data.items,
    )


# Testteki tüm logları DEBUG seviyesinden itibaren yakalar.
@pytest.fixture(autouse=True)
def capture_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)


# modelVersion'ın kurulumda model adı ve explain-v1 sürümünden kurulduğunu doğrular.
def test_model_version_is_computed_at_construction() -> None:
    llm = FakeLlm()

    pipeline = make_pipeline(llm)

    assert pipeline.model_version == MODEL_VERSION
    assert llm.calls == []


# 64 karakteri aşan modelVersion'ın kurulumu ValueError ile durdurduğunu doğrular.
def test_too_long_model_version_raises_value_error() -> None:
    with pytest.raises(ValueError):
        make_pipeline(FakeLlm(), ai_model="m" * 54)

    assert len(make_pipeline(FakeLlm(), ai_model="m" * 53).model_version) == 64


# Akışın açıklama kuyruğunu, olay türünü, prefetch'i ve metotları eşlediğini doğrular.
def test_flow_binds_explanation_queue_and_methods() -> None:
    pipeline = make_pipeline(FakeLlm())

    flow = pipeline.flow(Topology(explanation_queue="test-run.explanations"))

    assert flow == Flow(
        queue="test-run.explanations",
        event_type=LAB_EXPLANATION_REQUESTED,
        prefetch=EXPLANATION_PREFETCH,
        handle=pipeline.handle,
        build_failure=pipeline.build_failure,
    )
    assert pipeline.flow(Topology()).queue == "ai-service.lab-explanation-requested"
    assert EXPLANATION_PREFETCH == 4


# Başarıda yalnızca generated olayının sözleşmedeki alanlarla yayınlandığını doğrular.
async def test_success_publishes_generated_event() -> None:
    publisher = FakePublisher()
    clock = FakeClock(GENERATED_AT)
    pipeline = make_pipeline(FakeLlm(VALID_OUTPUT), clock)

    await pipeline.handle(requested_event(), cast(Publisher, publisher))

    [event] = publisher.events
    envelope = envelope_of(event)
    assert event.type == LAB_EXPLANATION_GENERATED
    assert envelope["subject"] == RECORD_ID
    assert envelope["time"] == GENERATED_AT_TEXT
    assert envelope["data"] == {
        "recordId": RECORD_ID,
        "modelVersion": MODEL_VERSION,
        "confidence": 0.82,
        "explanation": EXPECTED_EXPLANATION,
        "generatedAt": GENERATED_AT_TEXT,
    }
    assert clock.calls == 1
    assert parse_event(event.body, LAB_EXPLANATION_GENERATED).subject == RECORD_ID


# Modele görselsiz, açıklama talimatı, görev metni ve şemayla gidildiğini doğrular.
async def test_llm_receives_text_only_request_with_prompt_and_schema() -> None:
    llm = FakeLlm(VALID_OUTPUT)
    event = requested_event()

    await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    [call] = llm.calls
    assert call.system_prompt is EXPLAIN_SYSTEM_PROMPT
    assert call.user_text == expected_task_text(event)
    assert call.image_data_urls == ()
    assert call.schema_name == EXPLANATION_SCHEMA_NAME
    assert call.schema is EXPLANATION_SCHEMA
    assert call.follow_up == ()
    assert "yaklaşık 7 yaşında" in call.user_text
    assert '"species": "kedi"' in call.user_text


# Yayınlanan olayda doğrulanmış, kırpılmış metin ve kırpılmış güven skoru kullanılır.
async def test_generated_uses_validated_result() -> None:
    publisher = FakePublisher()
    output = output_text(
        confidence=1.7,
        summary="  Özet\n",
        items=[{"testName": " Kreatinin ", "explanation": "Açıklama", "x": 1}],
        extra=SECRET_MARKER,
    )

    await make_pipeline(FakeLlm(output)).handle(
        requested_event(), cast(Publisher, publisher)
    )

    data = envelope_of(publisher.events[0])["data"]
    assert data["confidence"] == 1.0
    assert data["explanation"] == {
        "summary": "Özet",
        "items": [{"testName": "Kreatinin", "explanation": "Açıklama"}],
    }


# Boş items'lı çıktının explanation'da yalnızca özetle yayınlandığını doğrular.
async def test_empty_items_are_published_without_items() -> None:
    publisher = FakePublisher()

    await make_pipeline(FakeLlm(output_text(items=[], confidence=0))).handle(
        requested_event(), cast(Publisher, publisher)
    )

    data = envelope_of(publisher.events[0])["data"]
    assert data["explanation"] == {"summary": EXPECTED_EXPLANATION["summary"]}
    assert "confidence" not in data


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
        ChatTurn("user", build_explanation_correction_text(issues_of(first_output))),
    )
    assert dataclasses.replace(second, follow_up=()) == first
    assert [event.type for event in publisher.events] == [LAB_EXPLANATION_GENERATED]
    data = envelope_of(publisher.events[0])["data"]
    assert data["explanation"] == EXPECTED_EXPLANATION


# İlk yanıt yarımsa aynı isteğin düz olarak bir kez tekrarlandığını doğrular.
async def test_incomplete_then_valid_output_repeats_same_request() -> None:
    llm = FakeLlm(IncompleteOutputError("yarım"), VALID_OUTPUT)
    publisher = FakePublisher()

    await make_pipeline(llm).handle(requested_event(), cast(Publisher, publisher))

    first, second = llm.calls
    assert second == first
    assert second.follow_up == ()
    assert [event.type for event in publisher.events] == [LAB_EXPLANATION_GENERATED]


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
    pytest.param({"title": ""}, id="baslik-bos"),
    pytest.param({"title": "   "}, id="baslik-bosluk"),
    pytest.param({"title": "a"}, id="baslik-tek-karakter"),
    pytest.param({"title": " a\n"}, id="baslik-kirpinca-tek-karakter"),
    pytest.param({"title": "a" * 129}, id="baslik-129"),
    pytest.param({"title": "Hemo\ngram"}, id="baslik-satir-sonu"),
    pytest.param({"title": "Hemo\tgram"}, id="baslik-sekme"),
    pytest.param({"title": "Hemo" + chr(0x7F) + "gram"}, id="baslik-del"),
    pytest.param({"sampled_at": ""}, id="numune-bos"),
    pytest.param({"sampled_at": "20.10.2026"}, id="numune-turkce-bicim"),
    pytest.param({"sampled_at": "2026-13-01"}, id="numune-ay-13"),
    pytest.param({"sampled_at": "2026-02-30"}, id="numune-30-subat"),
    pytest.param({"sampled_at": " 2026-10-20"}, id="numune-bosluklu"),
    pytest.param({"sampled_at": "2026-10-20T00:00:00Z"}, id="numune-saatli"),
    pytest.param({"sampled_at": "0999-01-01"}, id="numune-yil-1000-alti"),
    pytest.param(
        {
            "sampled_at": "".join(
                chr(0xFF10 + int(c)) if c.isdigit() else c for c in "2026-10-20"
            )
        },
        id="numune-tam-genislik",
    ),
    pytest.param({"birth_date": "2019-02-30"}, id="dogum-gecersiz"),
    pytest.param({"birth_date": "bilinmiyor"}, id="dogum-metin"),
    pytest.param({"birth_date": " "}, id="dogum-bosluk"),
    pytest.param({"items": []}, id="kalem-yok"),
    pytest.param(
        {"items": [lab_item(f"T{index}") for index in range(51)]}, id="kalem-51"
    ),
    pytest.param({"items": [lab_item("")]}, id="test-adi-bos"),
    pytest.param({"items": [lab_item("  ")]}, id="test-adi-bosluk"),
    pytest.param({"items": [lab_item("a" * 129)]}, id="test-adi-129"),
    pytest.param({"items": [lab_item("AL\nT")]}, id="test-adi-satir-sonu"),
    pytest.param({"items": [lab_item("ALT", value="")]}, id="deger-bos"),
    pytest.param({"items": [lab_item("ALT", value="1" * 65)]}, id="deger-65"),
    pytest.param({"items": [lab_item("ALT", value="1\t2")]}, id="deger-sekme"),
    pytest.param({"items": [lab_item("ALT", unit="u" * 33)]}, id="birim-33"),
    pytest.param({"items": [lab_item("ALT", unit="U\r/L")]}, id="birim-satir-sonu"),
    pytest.param(
        {"items": [lab_item("ALT", reference_range="1" * 65)]}, id="aralik-65"
    ),
    pytest.param(
        {"items": [lab_item("ALT", reference_range="1-\n2")]},
        id="aralik-satir-sonu",
    ),
    pytest.param({"items": [lab_item("ALT", flag=7)]}, id="flag-tanimsiz-7"),
    pytest.param({"items": [lab_item("ALT", flag=-1)]}, id="flag-negatif"),
    pytest.param(
        {"items": [*contract_items(), lab_item("Glukoz", value="")]},
        id="son-kalem-gecersiz",
    ),
]


# Geçersiz girdinin model çağrılmadan ve yayın yapılmadan INVALID_DATA verdiğini sınar.
@pytest.mark.parametrize("changes", INVALID_INPUTS)
async def test_invalid_input_is_invalid_message(changes: dict[str, Any]) -> None:
    llm = FakeLlm(VALID_OUTPUT)
    publisher = FakePublisher()

    with pytest.raises(InvalidMessageError) as raised:
        await make_pipeline(llm).handle(
            requested_event(**changes), cast(Publisher, publisher)
        )

    assert raised.value.reason == "INVALID_DATA"
    assert llm.calls == []
    assert publisher.events == []


# Verisi LabExplanationRequested olmayan olayın geçersiz mesaj sayıldığını doğrular.
async def test_non_requested_data_is_invalid_message() -> None:
    llm = FakeLlm(VALID_OUTPUT)
    event = dataclasses.replace(
        requested_event(),
        type=DOCUMENT_UPLOADED,
        data=events_pb2.DocumentUploaded(document_id=RECORD_ID),
    )

    with pytest.raises(InvalidMessageError) as raised:
        await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    assert raised.value.reason == "INVALID_DATA"
    assert llm.calls == []


VALID_INPUTS = [
    pytest.param({"title": "ab"}, id="baslik-2"),
    pytest.param({"title": "ş" * 128}, id="baslik-128"),
    pytest.param({"title": "\n Hemogram \t"}, id="baslik-kenar-bosluklari"),
    pytest.param({"birth_date": ""}, id="dogum-bos"),
    pytest.param({"birth_date": "2026-10-21"}, id="dogum-numuneden-sonra"),
    pytest.param({"species": ""}, id="tur-bos"),
    pytest.param({"species": "LIZARD"}, id="tur-listede-yok"),
    pytest.param({"species": SECRET_MARKER}, id="tur-serbest-metin"),
    pytest.param({"items": [lab_item("ALT")]}, id="tek-kalem"),
    pytest.param(
        {"items": [lab_item("ALT"), *(lab_item(f"T{i}") for i in range(49))]},
        id="elli-kalem",
    ),
    pytest.param(
        {
            "items": [
                lab_item(
                    "ALT" + "ş" * 125,
                    value="1" * 64,
                    unit="u" * 32,
                    reference_range="r" * 64,
                ),
                lab_item("ALT"),
            ]
        },
        id="ust-sinirlar",
    ),
    pytest.param({"items": [lab_item(" ALT\n", value=" 142 ")]}, id="kirpilan-kalem"),
    *(
        pytest.param({"items": [lab_item("ALT", flag=flag)]}, id=f"flag-{name}")
        for name, flag in medical_record_pb2.LabResultFlag.items()
    ),
]


# Sınırdaki ve isteğe bağlı alanları boş girdilerin kabul edildiğini doğrular.
@pytest.mark.parametrize("changes", VALID_INPUTS)
async def test_valid_inputs_are_accepted(changes: dict[str, Any]) -> None:
    llm = FakeLlm(VALID_OUTPUT)
    publisher = FakePublisher()
    event = requested_event(**changes)

    await make_pipeline(llm).handle(event, cast(Publisher, publisher))

    [call] = llm.calls
    assert call.user_text == expected_task_text(event)
    assert [event.type for event in publisher.events] == [LAB_EXPLANATION_GENERATED]


# Doğum tarihi numuneden sonraysa ya da tür bilinmiyorsa metne bilinmiyor yazılır.
async def test_unknown_age_and_species_reach_task_text() -> None:
    llm = FakeLlm(VALID_OUTPUT)
    event = requested_event(species="LIZARD", birth_date="2026-10-21")

    await make_pipeline(llm).handle(event, cast(Publisher, FakePublisher()))

    [call] = llm.calls
    assert '"species": "bilinmiyor"' in call.user_text
    assert '"age": "bilinmiyor"' in call.user_text
    assert "LIZARD" not in call.user_text


# build_failure'ın Akış B kodları için doğru mesaj ve data alanları ürettiğini doğrular.
@pytest.mark.parametrize("code", FLOW_B_CODES)
def test_build_failure_for_flow_b_codes(code: str) -> None:
    llm = FakeLlm()
    pipeline = make_pipeline(llm, FakeClock(FAILED_AT))

    failure = pipeline.build_failure(requested_event(), code)

    envelope = envelope_of(failure)
    assert failure.type == LAB_EXPLANATION_FAILED
    assert failure.subject == RECORD_ID
    assert envelope["type"] == LAB_EXPLANATION_FAILED
    assert envelope["subject"] == RECORD_ID
    assert envelope["time"] == FAILED_AT_TEXT
    assert envelope["data"] == {
        "recordId": RECORD_ID,
        "modelVersion": MODEL_VERSION,
        "errorCode": code,
        "errorMessage": EXPLANATION_ERROR_MESSAGES[code],
        "failedAt": FAILED_AT_TEXT,
    }
    assert len(envelope["data"]["errorMessage"]) <= 500
    assert parse_event(failure.body, LAB_EXPLANATION_FAILED).subject == RECORD_ID
    assert llm.calls == []


# build_failure, verisi LabExplanationRequested olmayan olayda geçersiz mesaj verir.
def test_build_failure_rejects_non_requested_data() -> None:
    event = dataclasses.replace(
        requested_event(), data=events_pb2.DocumentUploaded(document_id=RECORD_ID)
    )

    with pytest.raises(InvalidMessageError):
        make_pipeline(FakeLlm()).build_failure(event, INVALID_AI_OUTPUT)


# Başarıda recordId, süre ve model alanlı tek bir info logu yazıldığını doğrular.
async def test_success_logs_info_with_allowed_fields(
    caplog: pytest.LogCaptureFixture,
) -> None:
    await make_pipeline(FakeLlm(VALID_OUTPUT)).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [record] = pipeline_records(caplog, logging.INFO)
    fields = vars(record)
    assert record.getMessage() == SUCCESS_MESSAGE
    assert fields["recordId"] == RECORD_ID
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
    assert vars(record)["recordId"] == RECORD_ID
    assert "summary" not in record.getMessage()
    assert_pipeline_fields(caplog)


# Yarım yanıtın tekrarında recordId'li bir warn logu yazıldığını doğrular.
async def test_incomplete_retry_logs_warning(caplog: pytest.LogCaptureFixture) -> None:
    await make_pipeline(FakeLlm(IncompleteOutputError("yarım"), VALID_OUTPUT)).handle(
        requested_event(), cast(Publisher, FakePublisher())
    )

    [record] = pipeline_records(caplog, logging.WARNING)
    assert record.getMessage() == INCOMPLETE_MESSAGE
    assert vars(record)["recordId"] == RECORD_ID
    assert_pipeline_fields(caplog)


# Hata yollarında başarı logu yazılmadığını doğrular.
async def test_failure_does_not_log_success(caplog: pytest.LogCaptureFixture) -> None:
    with pytest.raises(PermanentError):
        await make_pipeline(FakeLlm(INVALID_OUTPUT, INVALID_OUTPUT)).handle(
            requested_event(), cast(Publisher, FakePublisher())
        )

    assert pipeline_records(caplog, logging.INFO) == []


# Tahlil değerleri, model çıktısı ve sorun alanlarının loglanmadığını doğrular.
async def test_logs_never_contain_content_or_model_output(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_items = [lab_item(SECRET_MARKER, value=f"{SECRET_MARKER}-deger")]
    event = requested_event(title=f"Panel {SECRET_MARKER}", items=secret_items)
    corrected_output = output_text(
        items=[{"testName": SECRET_MARKER, "explanation": "Açıklama"}]
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
        "items[0].testName",
        "summary",
        "Panel",
        "kedi",
    )
    assert_pipeline_fields(caplog)
