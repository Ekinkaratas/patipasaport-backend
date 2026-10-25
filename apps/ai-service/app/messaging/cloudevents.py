import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, NoReturn, TypeGuard

from google.protobuf import json_format
from google.protobuf.message import Message

from app.generated import events_pb2

SPEC_VERSION = "1.0"
CONTENT_TYPE = "application/cloudevents+json"
DATA_CONTENT_TYPE = "application/json"
SOURCE = "/patipasaport/ai-service"

DOCUMENT_UPLOADED = "com.patipasaport.document.uploaded.v1"
DOCUMENT_PROCESSING_STARTED = "com.patipasaport.document.processing_started.v1"
DOCUMENT_ANALYZED = "com.patipasaport.document.analyzed.v1"
DOCUMENT_ANALYSIS_FAILED = "com.patipasaport.document.analysis_failed.v1"
LAB_EXPLANATION_REQUESTED = "com.patipasaport.lab_explanation.requested.v1"
LAB_EXPLANATION_GENERATED = "com.patipasaport.lab_explanation.generated.v1"
LAB_EXPLANATION_FAILED = "com.patipasaport.lab_explanation.failed.v1"

_DATASCHEMA_TABLE = {
    DOCUMENT_UPLOADED: "urn:patipasaport:events:DocumentUploaded:v1",
    DOCUMENT_PROCESSING_STARTED: "urn:patipasaport:events:DocumentProcessingStarted:v1",
    DOCUMENT_ANALYZED: "urn:patipasaport:events:DocumentAnalyzed:v1",
    DOCUMENT_ANALYSIS_FAILED: "urn:patipasaport:events:DocumentAnalysisFailed:v1",
    LAB_EXPLANATION_REQUESTED: "urn:patipasaport:events:LabExplanationRequested:v1",
    LAB_EXPLANATION_GENERATED: "urn:patipasaport:events:LabExplanationGenerated:v1",
    LAB_EXPLANATION_FAILED: "urn:patipasaport:events:LabExplanationFailed:v1",
}
DATASCHEMAS: Mapping[str, str] = MappingProxyType(_DATASCHEMA_TABLE)


@dataclass(frozen=True)
class EventSpec:
    type: str
    dataschema: str
    message_class: type[Message]
    id_field: str


EVENT_SPECS: Mapping[str, EventSpec] = MappingProxyType(
    {
        spec.type: spec
        for spec in (
            EventSpec(
                type=DOCUMENT_UPLOADED,
                dataschema=DATASCHEMAS[DOCUMENT_UPLOADED],
                message_class=events_pb2.DocumentUploaded,
                id_field="document_id",
            ),
            EventSpec(
                type=DOCUMENT_PROCESSING_STARTED,
                dataschema=DATASCHEMAS[DOCUMENT_PROCESSING_STARTED],
                message_class=events_pb2.DocumentProcessingStarted,
                id_field="document_id",
            ),
            EventSpec(
                type=DOCUMENT_ANALYZED,
                dataschema=DATASCHEMAS[DOCUMENT_ANALYZED],
                message_class=events_pb2.DocumentAnalyzed,
                id_field="document_id",
            ),
            EventSpec(
                type=DOCUMENT_ANALYSIS_FAILED,
                dataschema=DATASCHEMAS[DOCUMENT_ANALYSIS_FAILED],
                message_class=events_pb2.DocumentAnalysisFailed,
                id_field="document_id",
            ),
        )
    }
)


class InvalidMessageError(Exception):
    # Hatayı girdi değeri taşımayan sabit bir neden koduyla oluşturur.
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class IncomingEvent:
    id: str
    type: str
    source: str
    subject: str
    time: datetime
    data: Message


@dataclass(frozen=True)
class OutgoingEvent:
    id: str
    type: str
    subject: str
    body: bytes


_UUID_V4 = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE | re.ASCII,
)


# JSON'da standart dışı olan NaN ve Infinity sabitlerini reddeder.
def _reject_constant(name: str) -> NoReturn:
    raise ValueError("Standart dışı JSON sabiti")


# Değerin boş olmayan ve yalnızca boşluktan oluşmayan bir metin olup olmadığını söyler.
def _is_non_empty_text(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and value.strip() != ""


# Zaman dilimi olmayan zamanı UTC kabul eder, olanı UTC'ye çevirir.
def _as_utc(moment: datetime) -> datetime:
    if moment.utcoffset() is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


# Zamanı UTC'de, milisaniyeli ve Z ile biten ISO-8601 metnine çevirir.
def _format_time(moment: datetime) -> str:
    text = _as_utc(moment).isoformat(timespec="milliseconds")
    return text.replace("+00:00", "Z")


# Gövdeyi katı UTF-8 JSON olarak çözer ve sonucun bir nesne olduğunu doğrular.
def _decode_envelope(body: bytes) -> dict[str, Any]:
    try:
        decoded = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    except ValueError, RecursionError:
        raise InvalidMessageError("NOT_JSON") from None
    if not isinstance(decoded, dict):
        raise InvalidMessageError("INVALID_ENVELOPE")
    return decoded


# Zarftaki time değerini ISO-8601 olarak okuyup UTC'ye çevirir.
def _parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise InvalidMessageError("INVALID_ENVELOPE")
    try:
        return _as_utc(datetime.fromisoformat(value))
    except ValueError, OverflowError:
        raise InvalidMessageError("INVALID_ENVELOPE") from None


# Zarftaki data nesnesini bilinmeyen alanları yok sayarak proto mesajına okur.
def _parse_data(data: dict[str, Any], message_class: type[Message]) -> Message:
    message = message_class()
    try:
        return json_format.ParseDict(data, message, ignore_unknown_fields=True)
    except json_format.ParseError, ValueError, TypeError, OverflowError:
        raise InvalidMessageError("INVALID_DATA") from None


# Proto mesajını CloudEvents zarfına koyup yayınlanacak JSON gövdesini üretir.
def build_event(
    data: Message,
    event_type: str,
    *,
    now: datetime | None = None,
    event_id: str | None = None,
) -> OutgoingEvent:
    spec = EVENT_SPECS.get(event_type)
    if spec is None:
        raise ValueError("Olay türü kayıt defterinde yok")
    if not isinstance(data, spec.message_class):
        raise ValueError("Mesaj, olay türünün proto sınıfından değil")
    subject: str = getattr(data, spec.id_field)
    if not subject.strip():
        raise ValueError("Olayın kimlik alanı boş")
    identifier = str(uuid.uuid4()) if event_id is None else event_id
    envelope = {
        "specversion": SPEC_VERSION,
        "id": identifier,
        "source": SOURCE,
        "type": event_type,
        "subject": subject,
        "time": _format_time(datetime.now(UTC) if now is None else now),
        "datacontenttype": DATA_CONTENT_TYPE,
        "dataschema": spec.dataschema,
        "data": json_format.MessageToDict(data),
    }
    body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
    return OutgoingEvent(
        id=identifier, type=event_type, subject=subject, body=body.encode("utf-8")
    )


# Gövdeyi doğrulayıp beklenen türde olaya çevirir; geçersizse neden koduyla reddeder.
def parse_event(body: bytes, expected_type: str) -> IncomingEvent:
    envelope = _decode_envelope(body)
    event_id = envelope.get("id")
    source = envelope.get("source")
    subject = envelope.get("subject")
    data = envelope.get("data")
    if (
        envelope.get("specversion") != SPEC_VERSION
        or not _is_non_empty_text(event_id)
        or not _is_non_empty_text(source)
        or not _is_non_empty_text(subject)
        or envelope.get("datacontenttype") != DATA_CONTENT_TYPE
        or not isinstance(data, dict)
    ):
        raise InvalidMessageError("INVALID_ENVELOPE")
    event_time = _parse_time(envelope.get("time"))
    spec = EVENT_SPECS.get(expected_type)
    if envelope.get("type") != expected_type or spec is None:
        raise InvalidMessageError("UNEXPECTED_TYPE")
    if envelope.get("dataschema") != spec.dataschema:
        raise InvalidMessageError("INVALID_ENVELOPE")
    message = _parse_data(data, spec.message_class)
    identifier = getattr(message, spec.id_field)
    if not _UUID_V4.fullmatch(identifier):
        raise InvalidMessageError("INVALID_ID")
    if identifier != subject:
        raise InvalidMessageError("SUBJECT_MISMATCH")
    return IncomingEvent(
        id=event_id,
        type=expected_type,
        source=source,
        subject=subject,
        time=event_time,
        data=message,
    )
