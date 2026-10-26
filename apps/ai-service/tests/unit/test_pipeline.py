import copy
import dataclasses
import io
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, cast

import pytest
from PIL import Image

from app.documents import pipeline as pipeline_module
from app.documents.pipeline import MAX_SIZE_BYTES, DocumentPipeline
from app.documents.validate import (
    ExtractionInvalid,
    ValidationIssue,
    validate_extraction,
)
from app.errors import (
    AI_PROVIDER_REJECTED,
    ERROR_MESSAGES,
    FILE_INTEGRITY_ERROR,
    FILE_NOT_FOUND,
    INVALID_AI_OUTPUT,
    NOT_A_MEDICAL_DOCUMENT,
    UNREADABLE_DOCUMENT,
    UNSUPPORTED_MIME_TYPE,
    PermanentError,
    TransientError,
)
from app.generated import events_pb2
from app.llm.client import (
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    LlmReply,
    UnexpectedStatusError,
)
from app.llm.prompts import (
    EXTRACT_SYSTEM_PROMPT,
    EXTRACT_TASK_TEXT,
    build_correction_text,
)
from app.llm.schemas import EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME
from app.logs import JsonFormatter
from app.messaging.cloudevents import (
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_ANALYZED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    parse_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import UNROUTABLE, Publisher, PublishError
from app.messaging.topology import DOCUMENT_PREFETCH, Topology
from app.storage import DocumentStorage

DOCUMENT_ID = "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
EVENT_ID = "5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b"
PET_ID = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5c"
CLINIC_ID = "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718"
STORAGE_UUID = "3f2b8c1d-6a4e-4b7f-9c0d-1e2f3a4b5c6d"
STORAGE_PATH = f"{STORAGE_UUID}.pdf"
SIZE_BYTES = 123_467
SHA256 = "0123456789abcdef" * 4
PDF_MIME_TYPE = "application/pdf"
MEDICAL_RECORD_SOURCE = "/patipasaport/medical-record"
FAKE_MODEL = "sahte-model"
MODEL_VERSION = "sahte-model/extract-v1"
EVENT_TIME = datetime(2024, 3, 20, 9, 0, tzinfo=UTC)
EVENT_DAY = "2024-03-20"
DOCUMENT_DAY = "2024-03-15"
STARTED_AT = datetime(2026, 10, 26, 9, 30, 15, 123456, tzinfo=UTC)
STARTED_AT_TEXT = "2026-10-26T09:30:15.123Z"
ANALYZED_AT = datetime(
    2026, 10, 26, 12, 31, 2, 987654, tzinfo=timezone(timedelta(hours=3))
)
ANALYZED_AT_TEXT = "2026-10-26T09:31:02.987Z"
FAILED_AT = datetime(2026, 10, 26, 9, 45)
FAILED_AT_TEXT = "2026-10-26T09:45:00.000Z"
SECRET_MARKER = "GIZLI-BELGE-ICERIGI-9Z"
CONTENT = b"%PDF-1.7 sahte belge " + SECRET_MARKER.encode()
IMAGES = (
    f"data:image/jpeg;base64,{SECRET_MARKER}-sayfa-1",
    f"data:image/jpeg;base64,{SECRET_MARKER}-sayfa-2",
    f"data:image/jpeg;base64,{SECRET_MARKER}-sayfa-3",
)
PIPELINE_LOGGER = "DocumentPipeline"
PIPELINE_LOG_FIELDS = frozenset({"documentId", "durationMs", "model"})
STANDARD_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
}
TIME_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"
)
SUCCESS_MESSAGE = "Belge okundu, kayıt önerisi yayınlandı"
INCOMPLETE_MESSAGE = "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor"

VALID_OUTPUT_DATA: dict[str, Any] = {
    "isMedicalDocument": True,
    "confidence": 0.86,
    "proposal": {
        "type": "LAB_RESULT",
        "title": "Hemogram",
        "notes": f"Tıbbi not {SECRET_MARKER}",
        "recordedAt": DOCUMENT_DAY,
        "labResult": {
            "sampledAt": DOCUMENT_DAY,
            "items": [
                {
                    "testName": "WBC",
                    "value": "12.4",
                    "unit": "10^3/uL",
                    "referenceRange": "5.5-19.5",
                    "flag": "NORMAL",
                }
            ],
        },
        "vaccination": None,
        "prescription": None,
    },
}
EXPECTED_PROPOSAL: dict[str, Any] = {
    "type": "LAB_RESULT",
    "title": "Hemogram",
    "notes": f"Tıbbi not {SECRET_MARKER}",
    "recordedAt": DOCUMENT_DAY,
    "labResult": {
        "sampledAt": DOCUMENT_DAY,
        "items": [
            {
                "testName": "WBC",
                "value": "12.4",
                "unit": "10^3/uL",
                "referenceRange": "5.5-19.5",
                "flag": "NORMAL",
            }
        ],
    },
}


# Geçerli model çıktısını verilen proposal değişiklikleriyle JSON metni olarak üretir.
def output_text(**proposal_changes: Any) -> str:
    data = copy.deepcopy(VALID_OUTPUT_DATA)
    data["proposal"].update(proposal_changes)
    return json.dumps(data, ensure_ascii=False)


VALID_OUTPUT = output_text()
INVALID_OUTPUT = output_text(title=None, notes=f"{SECRET_MARKER}\x00", type="LAB")
NOT_JSON_OUTPUT = f"bu bir JSON degil {SECRET_MARKER}"
NOT_MEDICAL_OUTPUT = json.dumps(
    {"isMedicalDocument": False, "confidence": 0.9, "proposal": None}
)
UNDATED_OUTPUT = json.dumps(
    {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "EXAMINATION",
            "title": "Genel muayene",
            "notes": "",
            "recordedAt": "",
            "labResult": None,
            "vaccination": None,
            "prescription": None,
        },
    }
)


@dataclass(frozen=True)
class LlmCall:
    system_prompt: str
    user_text: str
    image_data_urls: tuple[str, ...]
    schema_name: str
    schema: Mapping[str, object]
    follow_up: tuple[ChatTurn, ...]


class FakeStorage:
    # Sahte depoyu döndüreceği içerik ya da hata ve zaman çizelgesiyle kurar.
    def __init__(
        self,
        timeline: list[str],
        content: bytes = CONTENT,
        error: BaseException | None = None,
    ) -> None:
        self.timeline = timeline
        self.content = content
        self.error = error
        self.calls: list[tuple[str, int, str]] = []

    # Okuma argümanlarını kaydeder; hata tanımlıysa fırlatır, değilse içeriği döndürür.
    async def read(
        self, storage_path: str, expected_size: int, expected_sha256: str
    ) -> bytes:
        self.calls.append((storage_path, expected_size, expected_sha256))
        self.timeline.append("storage.read")
        if self.error is not None:
            raise self.error
        return self.content


class FakeLlm:
    # Sahte AI API istemcisini sırayla döndüreceği çıktı ya da hatalarla kurar.
    def __init__(self, timeline: list[str], *outcomes: str | BaseException) -> None:
        self.timeline = timeline
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
        self.timeline.append("llm.complete_json")
        if len(self.calls) > len(self.outcomes):
            raise AssertionError("Beklenenden fazla model çağrısı yapıldı")
        outcome = self.outcomes[len(self.calls) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return LlmReply(outcome, prompt_tokens=11, completion_tokens=22)


class FakePublisher:
    # Sahte yayıncıyı zaman çizelgesi ve isteğe bağlı yayın hatasıyla kurar.
    def __init__(self, timeline: list[str], error: BaseException | None = None) -> None:
        self.timeline = timeline
        self.error = error
        self.events: list[OutgoingEvent] = []

    # Olayı kaydeder; tanımlıysa hatayı fırlatır.
    async def publish(self, event: OutgoingEvent) -> None:
        self.events.append(event)
        self.timeline.append(f"publish:{event.type}")
        if self.error is not None:
            raise self.error


class PrepareSpy:
    # Görsel hazırlama çağrılarını kaydeden ve sabit görseller döndüren casusu kurar.
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline
        self.calls: list[tuple[bytes, str]] = []

    # İçeriği ve türü kaydeder, sahte data URL listesini döndürür.
    async def __call__(self, content: bytes, mime_type: str) -> list[str]:
        self.calls.append((content, mime_type))
        self.timeline.append("prepare_images")
        return list(IMAGES)


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


# Verilen alan değişiklikleriyle geçerli bir document.uploaded olayı üretir.
def uploaded_event(**changes: Any) -> IncomingEvent:
    fields: dict[str, Any] = {
        "document_id": DOCUMENT_ID,
        "pet_id": PET_ID,
        "clinic_id": CLINIC_ID,
        "storage_path": STORAGE_PATH,
        "mime_type": PDF_MIME_TYPE,
        "size_bytes": SIZE_BYTES,
        "sha256": SHA256,
    }
    fields.update(changes)
    return IncomingEvent(
        id=EVENT_ID,
        type=DOCUMENT_UPLOADED,
        source=MEDICAL_RECORD_SOURCE,
        subject=DOCUMENT_ID,
        time=EVENT_TIME,
        data=events_pb2.DocumentUploaded(**fields),
    )


# Sahte depo ve AI API istemcisiyle, istenirse sahte saati kullanan bir akış kurar.
def make_pipeline(
    storage: FakeStorage,
    llm: FakeLlm,
    clock: FakeClock | None = None,
    ai_model: str = FAKE_MODEL,
) -> DocumentPipeline:
    if clock is None:
        return DocumentPipeline(
            cast(DocumentStorage, storage), cast(LlmClient, llm), ai_model
        )
    return DocumentPipeline(
        cast(DocumentStorage, storage), cast(LlmClient, llm), ai_model, clock=clock
    )


# Model çıktısının doğrulama sorunlarını validate_extraction ile hesaplar.
def issues_of(output: str) -> tuple[ValidationIssue, ...]:
    with pytest.raises(ExtractionInvalid) as raised:
        validate_extraction(output, event_time=EVENT_TIME)
    return raised.value.issues


# Yayınlanan olayın CloudEvents zarfını sözlük olarak döndürür.
def envelope_of(event: OutgoingEvent) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(event.body))


# Yayınlanan olayların türlerini sırasıyla döndürür.
def published_types(publisher: FakePublisher) -> list[str]:
    return [event.type for event in publisher.events]


# Küçük, geçerli bir PNG görselinin baytlarını üretir.
def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 3), (200, 10, 10)).save(buffer, format="PNG")
    return buffer.getvalue()


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


# Testin paylaştığı çağrı zaman çizelgesini döndürür.
@pytest.fixture
def timeline() -> list[str]:
    return []


# Akış modülündeki prepare_images'ı sabit görseller döndüren casusla değiştirir.
@pytest.fixture
def prepare(monkeypatch: pytest.MonkeyPatch, timeline: list[str]) -> PrepareSpy:
    spy = PrepareSpy(timeline)
    monkeypatch.setattr(pipeline_module, "prepare_images", spy)
    return spy


# Testteki tüm logları DEBUG seviyesinden itibaren yakalar.
@pytest.fixture(autouse=True)
def capture_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)


# modelVersion'ın kurulumda model adı ve talimat sürümünden kurulduğunu doğrular.
def test_model_version_is_computed_at_construction(timeline: list[str]) -> None:
    storage = FakeStorage(timeline)
    llm = FakeLlm(timeline)

    pipeline = make_pipeline(storage, llm)

    assert pipeline.model_version == MODEL_VERSION
    assert storage.calls == []
    assert llm.calls == []


# 64 karakteri aşan modelVersion'ın kurulumu ValueError ile durdurduğunu doğrular.
def test_too_long_model_version_raises_value_error(timeline: list[str]) -> None:
    with pytest.raises(ValueError):
        make_pipeline(FakeStorage(timeline), FakeLlm(timeline), ai_model="m" * 54)

    pipeline = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline), ai_model="m" * 53
    )
    assert len(pipeline.model_version) == 64


# Akışın belge kuyruğunu, olay türünü, prefetch'i ve metotları eşlediğini doğrular.
def test_flow_binds_document_queue_and_methods(timeline: list[str]) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline))
    topology = Topology(document_queue="test-run.documents")

    flow = pipeline.flow(topology)

    assert flow == Flow(
        queue="test-run.documents",
        event_type=DOCUMENT_UPLOADED,
        prefetch=DOCUMENT_PREFETCH,
        handle=pipeline.handle,
        build_failure=pipeline.build_failure,
    )
    assert pipeline.flow(Topology()).queue == "ai-service.document-uploaded"
    assert DOCUMENT_PREFETCH == 2


# Başarı yolunda adımların ve yayınların sözleşmedeki sırayla yapıldığını doğrular.
async def test_success_runs_steps_in_order(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert timeline == [
        f"publish:{DOCUMENT_PROCESSING_STARTED}",
        "storage.read",
        "prepare_images",
        "llm.complete_json",
        f"publish:{DOCUMENT_ANALYZED}",
    ]
    assert published_types(publisher) == [
        DOCUMENT_PROCESSING_STARTED,
        DOCUMENT_ANALYZED,
    ]


# processing_started ve analyzed olaylarının zarf ve data alanlarını doğrular.
async def test_success_events_have_expected_data(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    publisher = FakePublisher(timeline)
    clock = FakeClock(STARTED_AT, ANALYZED_AT)
    pipeline = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT), clock
    )

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    started, analyzed = map(envelope_of, publisher.events)
    assert started["type"] == DOCUMENT_PROCESSING_STARTED
    assert started["subject"] == DOCUMENT_ID
    assert started["time"] == STARTED_AT_TEXT
    assert started["data"] == {
        "documentId": DOCUMENT_ID,
        "modelVersion": MODEL_VERSION,
        "startedAt": STARTED_AT_TEXT,
    }
    assert analyzed["type"] == DOCUMENT_ANALYZED
    assert analyzed["subject"] == DOCUMENT_ID
    assert analyzed["time"] == ANALYZED_AT_TEXT
    assert analyzed["data"] == {
        "documentId": DOCUMENT_ID,
        "modelVersion": MODEL_VERSION,
        "confidence": 0.86,
        "proposal": EXPECTED_PROPOSAL,
        "analyzedAt": ANALYZED_AT_TEXT,
    }
    assert clock.calls == 2
    for event, event_type in zip(
        publisher.events, (DOCUMENT_PROCESSING_STARTED, DOCUMENT_ANALYZED), strict=True
    ):
        assert parse_event(event.body, event_type).subject == DOCUMENT_ID


# Analyzed olayında doğrulanmış güven skoru ve olay tarihinin kullanıldığını doğrular.
async def test_analyzed_uses_validated_result_and_event_time(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, UNDATED_OUTPUT))

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    data = envelope_of(publisher.events[-1])["data"]
    assert data["confidence"] == 0.5
    assert data["proposal"]["recordedAt"] == EVENT_DAY


# Varsayılan saatin milisaniyeli, Z ile biten şimdiki UTC zamanı verdiğini doğrular.
async def test_default_clock_uses_current_utc_time(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))
    before = datetime.now(UTC).replace(microsecond=0)

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))
    failure = pipeline.build_failure(uploaded_event(), INVALID_AI_OUTPUT)

    after = datetime.now(UTC)
    texts = [
        envelope_of(publisher.events[0])["data"]["startedAt"],
        envelope_of(publisher.events[1])["data"]["analyzedAt"],
        envelope_of(failure)["data"]["failedAt"],
    ]
    for text in texts:
        assert TIME_PATTERN.fullmatch(text)
        assert before <= datetime.fromisoformat(text) <= after


# Depoya mesajdaki anahtar, boyut ve sha256'nın aynen gittiğini doğrular.
async def test_storage_receives_message_fields(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    storage = FakeStorage(timeline)
    pipeline = make_pipeline(storage, FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    assert storage.calls == [(STORAGE_PATH, SIZE_BYTES, SHA256)]


# Görsel hazırlamaya depodan okunan içerik ile mesajdaki türün gittiğini doğrular.
async def test_prepare_receives_storage_content_and_mime_type(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    assert prepare.calls == [(CONTENT, PDF_MIME_TYPE)]


# Modele görsellerin sırayla, talimat ve şema sabitleriyle gittiğini doğrular.
async def test_llm_receives_images_in_order_with_prompt_and_schema(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    llm = FakeLlm(timeline, VALID_OUTPUT)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    [call] = llm.calls
    assert call.image_data_urls == IMAGES
    assert call.system_prompt is EXTRACT_SYSTEM_PROMPT
    assert call.user_text is EXTRACT_TASK_TEXT
    assert call.schema_name == EXTRACTION_SCHEMA_NAME
    assert call.schema is EXTRACTION_SCHEMA
    assert call.follow_up == ()


# Gerçek görsel hazırlamayla PNG'nin tek bir JPEG data URL'i olarak gittiğini doğrular.
async def test_real_image_preparation_sends_jpeg_data_url(
    timeline: list[str],
) -> None:
    llm = FakeLlm(timeline, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline, content=png_bytes()), llm)
    event = uploaded_event(storage_path=f"{STORAGE_UUID}.png", mime_type="image/png")

    await pipeline.handle(event, cast(Publisher, publisher))

    [call] = llm.calls
    [image] = call.image_data_urls
    assert image.startswith("data:image/jpeg;base64,")
    assert published_types(publisher) == [
        DOCUMENT_PROCESSING_STARTED,
        DOCUMENT_ANALYZED,
    ]


INVALID_STORAGE_PATHS = [
    pytest.param("", id="bos"),
    pytest.param(STORAGE_UUID, id="uzantisiz"),
    pytest.param(f"{STORAGE_UUID}.", id="bos-uzanti"),
    pytest.param(f"{STORAGE_UUID}.gif", id="gif"),
    pytest.param(f"{STORAGE_UUID}.jpeg", id="jpeg"),
    pytest.param(f"{STORAGE_UUID}.PDF", id="buyuk-harf-uzanti"),
    pytest.param(f"{STORAGE_UUID}.pdf.png", id="cift-uzanti"),
    pytest.param(f"../{STORAGE_UUID}.pdf", id="ust-dizin"),
    pytest.param(f"belgeler/{STORAGE_UUID}.pdf", id="alt-dizin"),
    pytest.param(f" {STORAGE_UUID}.pdf", id="bastaki-bosluk"),
    pytest.param(f"{STORAGE_UUID}.pdf\n", id="sondaki-satir-sonu"),
    pytest.param(f"{STORAGE_UUID}.pdf" + chr(0), id="nul-karakteri"),
    pytest.param(f"{STORAGE_UUID.replace('-', '')}.pdf", id="tiresiz"),
    pytest.param(f"{STORAGE_UUID[:-1]}.pdf", id="kisa-grup"),
    pytest.param(f"{STORAGE_UUID}0.pdf", id="uzun-grup"),
    pytest.param(f"g{STORAGE_UUID[1:]}.pdf", id="hex-olmayan"),
    pytest.param(f"{{{STORAGE_UUID}}}.pdf", id="suslu-parantez"),
    pytest.param(chr(0xFF13) + f"{STORAGE_UUID[1:]}.pdf", id="tam-genislik-rakam"),
]
VALID_STORAGE_PATHS = [
    pytest.param(f"{STORAGE_UUID}.pdf", id="pdf"),
    pytest.param(f"{STORAGE_UUID}.jpg", id="jpg"),
    pytest.param(f"{STORAGE_UUID}.png", id="png"),
    pytest.param(f"{STORAGE_UUID.upper()}.pdf", id="buyuk-harf-uuid"),
    pytest.param("3F2b8C1d-6A4e-4B7f-9C0d-1E2f3A4b5C6d.png", id="karisik-harf-uuid"),
    pytest.param("3f2b8c1d-6a4e-1b7f-0c0d-1e2f3a4b5c6d.jpg", id="v4-olmayan-uuid"),
]
INVALID_SIZES = [
    pytest.param(0, id="sifir"),
    pytest.param(-1, id="negatif"),
    pytest.param(MAX_SIZE_BYTES + 1, id="sinirin-ustu"),
    pytest.param(2**31 - 1, id="int32-en-buyuk"),
    pytest.param(-(2**31), id="int32-en-kucuk"),
]
INVALID_SHA256_VALUES = [
    pytest.param("", id="bos"),
    pytest.param(SHA256.upper(), id="buyuk-harf"),
    pytest.param(SHA256[:-1], id="63-karakter"),
    pytest.param(SHA256 + "0", id="65-karakter"),
    pytest.param("g" + SHA256[1:], id="hex-olmayan"),
    pytest.param(" " + SHA256[1:], id="bosluk"),
    pytest.param(SHA256 + "\n", id="sondaki-satir-sonu"),
    pytest.param(chr(0xFF10) + SHA256[1:], id="tam-genislik-rakam"),
]
UNSUPPORTED_MIME_TYPES = [
    pytest.param("image/gif", id="gif"),
    pytest.param("", id="bos"),
    pytest.param("application/PDF", id="buyuk-harf"),
    pytest.param("image/jpg", id="image-jpg"),
    pytest.param("text/plain", id="metin"),
    pytest.param(" image/png", id="bosluklu"),
]


# Geçersiz dosya anahtarının yayın yapmadan InvalidMessageError verdiğini doğrular.
@pytest.mark.parametrize("storage_path", INVALID_STORAGE_PATHS)
async def test_invalid_storage_path_is_invalid_message(
    timeline: list[str], prepare: PrepareSpy, storage_path: str
) -> None:
    storage = FakeStorage(timeline)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(storage, FakeLlm(timeline, VALID_OUTPUT))

    with pytest.raises(InvalidMessageError) as raised:
        await pipeline.handle(
            uploaded_event(storage_path=storage_path), cast(Publisher, publisher)
        )

    assert raised.value.reason == "INVALID_DATA"
    assert timeline == []


# Geçerli biçimdeki dosya anahtarlarının kabul edilip depoya aynen gittiğini doğrular.
@pytest.mark.parametrize("storage_path", VALID_STORAGE_PATHS)
async def test_valid_storage_paths_are_accepted(
    timeline: list[str], prepare: PrepareSpy, storage_path: str
) -> None:
    storage = FakeStorage(timeline)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(storage, FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(
        uploaded_event(storage_path=storage_path), cast(Publisher, publisher)
    )

    assert storage.calls == [(storage_path, SIZE_BYTES, SHA256)]
    assert published_types(publisher)[-1] == DOCUMENT_ANALYZED


# Aralık dışı boyutun hiçbir şey yayınlamadan InvalidMessageError verdiğini doğrular.
@pytest.mark.parametrize("size_bytes", INVALID_SIZES)
async def test_invalid_size_is_invalid_message(
    timeline: list[str], prepare: PrepareSpy, size_bytes: int
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    with pytest.raises(InvalidMessageError) as raised:
        await pipeline.handle(
            uploaded_event(size_bytes=size_bytes),
            cast(Publisher, FakePublisher(timeline)),
        )

    assert raised.value.reason == "INVALID_DATA"
    assert timeline == []


# 1 bayt ve 10 MB sınırlarının kabul edildiğini doğrular.
@pytest.mark.parametrize("size_bytes", [1, MAX_SIZE_BYTES])
async def test_boundary_sizes_are_accepted(
    timeline: list[str], prepare: PrepareSpy, size_bytes: int
) -> None:
    storage = FakeStorage(timeline)
    pipeline = make_pipeline(storage, FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(
        uploaded_event(size_bytes=size_bytes), cast(Publisher, FakePublisher(timeline))
    )

    assert storage.calls == [(STORAGE_PATH, size_bytes, SHA256)]
    assert MAX_SIZE_BYTES == 10_485_760


# Geçersiz sha256'nın hiçbir şey yayınlamadan InvalidMessageError verdiğini doğrular.
@pytest.mark.parametrize("sha256", INVALID_SHA256_VALUES)
async def test_invalid_sha256_is_invalid_message(
    timeline: list[str], prepare: PrepareSpy, sha256: str
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    with pytest.raises(InvalidMessageError) as raised:
        await pipeline.handle(
            uploaded_event(sha256=sha256), cast(Publisher, FakePublisher(timeline))
        )

    assert raised.value.reason == "INVALID_DATA"
    assert timeline == []


# Desteklenmeyen türün yayından önce UNSUPPORTED_MIME_TYPE verdiğini doğrular.
@pytest.mark.parametrize("mime_type", UNSUPPORTED_MIME_TYPES)
async def test_unsupported_mime_type_fails_before_processing_started(
    timeline: list[str], prepare: PrepareSpy, mime_type: str
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    with pytest.raises(PermanentError) as raised:
        await pipeline.handle(
            uploaded_event(mime_type=mime_type),
            cast(Publisher, FakePublisher(timeline)),
        )

    assert raised.value.code == UNSUPPORTED_MIME_TYPE
    assert timeline == []


# Alan hatası ile desteklenmeyen tür birlikteyse mesajın geçersiz sayıldığını doğrular.
async def test_invalid_field_wins_over_unsupported_mime_type(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    with pytest.raises(InvalidMessageError):
        await pipeline.handle(
            uploaded_event(storage_path="belge.gif", mime_type="image/gif"),
            cast(Publisher, FakePublisher(timeline)),
        )

    assert timeline == []


# Verisi DocumentUploaded olmayan olayın geçersiz mesaj sayıldığını doğrular.
async def test_non_uploaded_data_is_invalid_message(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))
    event = dataclasses.replace(
        uploaded_event(),
        data=events_pb2.DocumentProcessingStarted(document_id=DOCUMENT_ID),
    )

    with pytest.raises(InvalidMessageError) as raised:
        await pipeline.handle(event, cast(Publisher, FakePublisher(timeline)))

    assert raised.value.reason == "INVALID_DATA"
    assert timeline == []


# İlk çıktı geçersiz, ikincisi geçerliyse düzeltmeyle analyzed yayınlandığını doğrular.
@pytest.mark.parametrize(
    "first_output",
    [
        pytest.param(INVALID_OUTPUT, id="kural-disi"),
        pytest.param(NOT_JSON_OUTPUT, id="json-degil"),
    ],
)
async def test_invalid_then_valid_output_sends_correction(
    timeline: list[str], prepare: PrepareSpy, first_output: str
) -> None:
    llm = FakeLlm(timeline, first_output, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    first, second = llm.calls
    assert first.follow_up == ()
    assert second.follow_up == (
        ChatTurn("assistant", first_output),
        ChatTurn("user", build_correction_text(issues_of(first_output))),
    )
    assert dataclasses.replace(second, follow_up=()) == first
    assert second.schema is EXTRACTION_SCHEMA
    assert second.image_data_urls == IMAGES
    assert published_types(publisher) == [
        DOCUMENT_PROCESSING_STARTED,
        DOCUMENT_ANALYZED,
    ]
    assert envelope_of(publisher.events[-1])["data"]["proposal"] == EXPECTED_PROPOSAL


# İlk yanıt yarımsa aynı isteğin düz olarak bir kez tekrarlandığını doğrular.
async def test_incomplete_then_valid_output_repeats_same_request(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    llm = FakeLlm(timeline, IncompleteOutputError("yarım"), VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    first, second = llm.calls
    assert second == first
    assert second.follow_up == ()
    assert published_types(publisher) == [
        DOCUMENT_PROCESSING_STARTED,
        DOCUMENT_ANALYZED,
    ]


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
    timeline: list[str],
    prepare: PrepareSpy,
    first_outcome: str | BaseException,
    second_outcome: str | BaseException,
) -> None:
    llm = FakeLlm(timeline, first_outcome, second_outcome, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    with pytest.raises(PermanentError) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value.code == INVALID_AI_OUTPUT
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__
    assert len(llm.calls) == 2
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


# NOT_A_MEDICAL_DOCUMENT'in her denemede olduğu gibi yükseldiğini doğrular.
@pytest.mark.parametrize(
    "outcomes",
    [
        pytest.param((NOT_MEDICAL_OUTPUT, VALID_OUTPUT), id="ilk-cagri"),
        pytest.param(
            (INVALID_OUTPUT, NOT_MEDICAL_OUTPUT, VALID_OUTPUT), id="duzeltmeden-sonra"
        ),
        pytest.param(
            (IncompleteOutputError("yarım"), NOT_MEDICAL_OUTPUT, VALID_OUTPUT),
            id="yarim-yanittan-sonra",
        ),
    ],
)
async def test_not_a_medical_document_propagates(
    timeline: list[str],
    prepare: PrepareSpy,
    outcomes: tuple[str | BaseException, ...],
) -> None:
    llm = FakeLlm(timeline, *outcomes)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    with pytest.raises(PermanentError) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value.code == NOT_A_MEDICAL_DOCUMENT
    assert len(llm.calls) == len(outcomes) - 1
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


STORAGE_ERRORS = [
    pytest.param(PermanentError, FILE_NOT_FOUND, id="dosya-yok"),
    pytest.param(PermanentError, FILE_INTEGRITY_ERROR, id="butunluk"),
    pytest.param(TransientError, "depo gecici hata", id="gecici"),
]
LLM_ERRORS = [
    pytest.param(PermanentError, AI_PROVIDER_REJECTED, id="reddedildi"),
    pytest.param(TransientError, "AI API gecici hata", id="gecici"),
    pytest.param(UnexpectedStatusError, 418, id="beklenmeyen-durum"),
]


# Depo hatalarının olduğu gibi yükseldiğini ve modelin çağrılmadığını doğrular.
@pytest.mark.parametrize(("error_type", "argument"), STORAGE_ERRORS)
async def test_storage_errors_propagate(
    timeline: list[str],
    prepare: PrepareSpy,
    error_type: type[Exception],
    argument: object,
) -> None:
    error = error_type(argument)
    llm = FakeLlm(timeline, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline, error=error), llm)

    with pytest.raises(error_type) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert prepare.calls == []
    assert llm.calls == []
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


# Görsel hazırlama hatasının olduğu gibi yükseldiğini, modelin çağrılmadığını doğrular.
async def test_unreadable_document_propagates(timeline: list[str]) -> None:
    llm = FakeLlm(timeline, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline, content=b"bozuk gorsel"), llm)
    event = uploaded_event(storage_path=f"{STORAGE_UUID}.png", mime_type="image/png")

    with pytest.raises(PermanentError) as raised:
        await pipeline.handle(event, cast(Publisher, publisher))

    assert raised.value.code == UNREADABLE_DOCUMENT
    assert llm.calls == []
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


# İlk model çağrısındaki istemci hatalarının olduğu gibi yükseldiğini doğrular.
@pytest.mark.parametrize(("error_type", "argument"), LLM_ERRORS)
async def test_llm_errors_on_first_call_propagate(
    timeline: list[str],
    prepare: PrepareSpy,
    error_type: type[Exception],
    argument: object,
) -> None:
    error = error_type(argument)
    llm = FakeLlm(timeline, error, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    with pytest.raises(error_type) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert len(llm.calls) == 1
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


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
    timeline: list[str],
    prepare: PrepareSpy,
    first_outcome: str | BaseException,
    error_type: type[Exception],
    argument: object,
) -> None:
    error = error_type(argument)
    llm = FakeLlm(timeline, first_outcome, error, VALID_OUTPUT)
    publisher = FakePublisher(timeline)
    pipeline = make_pipeline(FakeStorage(timeline), llm)

    with pytest.raises(error_type) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert len(llm.calls) == 2
    assert published_types(publisher) == [DOCUMENT_PROCESSING_STARTED]


# processing_started yayınlanamazsa akışın durup yayın hatasının yükseldiğini doğrular.
async def test_processing_started_publish_failure_stops_flow(
    timeline: list[str], prepare: PrepareSpy
) -> None:
    error = PublishError(UNROUTABLE)
    storage = FakeStorage(timeline)
    llm = FakeLlm(timeline, VALID_OUTPUT)
    publisher = FakePublisher(timeline, error)
    pipeline = make_pipeline(storage, llm)

    with pytest.raises(PublishError) as raised:
        await pipeline.handle(uploaded_event(), cast(Publisher, publisher))

    assert raised.value is error
    assert storage.calls == []
    assert llm.calls == []


# build_failure'ın her kod için doğru mesaj ve data alanları ürettiğini doğrular.
@pytest.mark.parametrize("code", list(ERROR_MESSAGES))
def test_build_failure_for_every_code(timeline: list[str], code: str) -> None:
    storage = FakeStorage(timeline)
    llm = FakeLlm(timeline)
    pipeline = make_pipeline(storage, llm, FakeClock(FAILED_AT))

    failure = pipeline.build_failure(uploaded_event(), code)

    envelope = envelope_of(failure)
    assert failure.type == DOCUMENT_ANALYSIS_FAILED
    assert failure.subject == DOCUMENT_ID
    assert envelope["type"] == DOCUMENT_ANALYSIS_FAILED
    assert envelope["subject"] == DOCUMENT_ID
    assert envelope["time"] == FAILED_AT_TEXT
    assert envelope["data"] == {
        "documentId": DOCUMENT_ID,
        "modelVersion": MODEL_VERSION,
        "errorCode": code,
        "errorMessage": ERROR_MESSAGES[code],
        "failedAt": FAILED_AT_TEXT,
    }
    assert parse_event(failure.body, DOCUMENT_ANALYSIS_FAILED).subject == DOCUMENT_ID
    assert storage.calls == []
    assert llm.calls == []


# Başarıda documentId, süre ve model alanlı tek bir info logu yazıldığını doğrular.
async def test_success_logs_info_with_allowed_fields(
    caplog: pytest.LogCaptureFixture, timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(FakeStorage(timeline), FakeLlm(timeline, VALID_OUTPUT))

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    [record] = pipeline_records(caplog, logging.INFO)
    fields = vars(record)
    assert record.getMessage() == SUCCESS_MESSAGE
    assert fields["documentId"] == DOCUMENT_ID
    assert fields["model"] == FAKE_MODEL
    assert isinstance(fields["durationMs"], int)
    assert fields["durationMs"] >= 0
    assert pipeline_records(caplog, logging.WARNING) == []
    assert_pipeline_fields(caplog)


# Düzeltme warn logunda sorun sayısının olduğunu, alan ve değerin olmadığını doğrular.
async def test_correction_logs_warning_with_issue_count(
    caplog: pytest.LogCaptureFixture, timeline: list[str], prepare: PrepareSpy
) -> None:
    issue_count = len(issues_of(INVALID_OUTPUT))
    pipeline = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline, INVALID_OUTPUT, VALID_OUTPUT)
    )

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    [record] = pipeline_records(caplog, logging.WARNING)
    assert issue_count == 3
    assert record.getMessage() == (
        f"Model çıktısı doğrulanamadı ({issue_count} sorun), düzeltme isteniyor"
    )
    assert vars(record)["documentId"] == DOCUMENT_ID
    assert "proposal" not in record.getMessage()
    assert_pipeline_fields(caplog)


# Yarım yanıtın tekrarında documentId'li bir warn logu yazıldığını doğrular.
async def test_incomplete_retry_logs_warning(
    caplog: pytest.LogCaptureFixture, timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(
        FakeStorage(timeline),
        FakeLlm(timeline, IncompleteOutputError("yarım"), VALID_OUTPUT),
    )

    await pipeline.handle(uploaded_event(), cast(Publisher, FakePublisher(timeline)))

    [record] = pipeline_records(caplog, logging.WARNING)
    assert record.getMessage() == INCOMPLETE_MESSAGE
    assert vars(record)["documentId"] == DOCUMENT_ID
    assert_pipeline_fields(caplog)


# Hata yollarında başarı logu yazılmadığını doğrular.
async def test_failure_does_not_log_success(
    caplog: pytest.LogCaptureFixture, timeline: list[str], prepare: PrepareSpy
) -> None:
    pipeline = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline, INVALID_OUTPUT, INVALID_OUTPUT)
    )

    with pytest.raises(PermanentError):
        await pipeline.handle(
            uploaded_event(), cast(Publisher, FakePublisher(timeline))
        )

    assert pipeline_records(caplog, logging.INFO) == []


# Belge içeriği, görseller, model çıktısı ve sorun alanlarının loglanmadığını doğrular.
async def test_logs_never_contain_content_or_model_output(
    caplog: pytest.LogCaptureFixture, timeline: list[str], prepare: PrepareSpy
) -> None:
    corrected = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline, INVALID_OUTPUT, VALID_OUTPUT)
    )
    failing = make_pipeline(
        FakeStorage(timeline), FakeLlm(timeline, NOT_JSON_OUTPUT, INVALID_OUTPUT)
    )
    publisher = FakePublisher(timeline)

    await corrected.handle(uploaded_event(), cast(Publisher, publisher))
    with pytest.raises(PermanentError):
        await failing.handle(uploaded_event(), cast(Publisher, publisher))

    assert SECRET_MARKER in publisher.events[1].body.decode("utf-8")
    assert len(pipeline_records(caplog, logging.WARNING)) == 2
    assert_not_logged(
        caplog,
        SECRET_MARKER,
        "proposal.title",
        "proposal.notes",
        "proposal.type",
        "Hemogram",
    )
    assert_pipeline_fields(caplog)
