import json
import re
import traceback
import uuid
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from google.protobuf.message import Message

from app.generated import events_pb2, medical_record_pb2
from app.messaging.cloudevents import (
    CONTENT_TYPE,
    DATA_CONTENT_TYPE,
    DATASCHEMAS,
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_ANALYZED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    EVENT_SPECS,
    LAB_EXPLANATION_FAILED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_REQUESTED,
    SOURCE,
    SPEC_VERSION,
    EventSpec,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    build_event,
    parse_event,
)

DOCUMENT_ID = "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
OTHER_DOCUMENT_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
RECORD_ID = "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
EVENT_ID = "5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b"
FAKE_SHA256 = "0123456789abcdef" * 4
FAKE_MODEL_VERSION = "sahte-model/extract-v1"
SECRET_MARKER = "GIZLI-GIRDI-7Q"
FIXED_NOW = datetime(2026, 10, 21, 9, 30, 0, 123000, tzinfo=UTC)
FIXED_TIME_TEXT = "2026-10-21T09:30:00.123Z"
ISO_UTC_MILLIS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
UUID_V4_LOWER = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
MISSING = object()
UNREGISTERED_TYPE = "com.patipasaport.unknown.v1"
DOCUMENT_TYPES = [
    DOCUMENT_UPLOADED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_ANALYZED,
    DOCUMENT_ANALYSIS_FAILED,
]
LAB_TYPES = [
    LAB_EXPLANATION_REQUESTED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_FAILED,
]
LAB_REQUESTED_DATA: dict[str, Any] = {
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
}
LAB_GENERATED_DATA: dict[str, Any] = {
    "recordId": RECORD_ID,
    "modelVersion": "gemma-4-31b/explain-v1",
    "confidence": 0.82,
    "explanation": {
        "summary": (
            "Tahlildeki değerlerin çoğu referans aralığında. Karaciğerle ilgili ALT "
            "değeri aralığın biraz üzerinde."
        ),
        "items": [
            {
                "testName": "ALT",
                "explanation": (
                    "ALT, karaciğer hücrelerinde bulunan bir enzimdir. Hafif "
                    "yükseklik farklı nedenlerle görülebilir; ne anlama geldiğini "
                    "veteriner hekiminiz muayene bulgularıyla birlikte "
                    "değerlendirir."
                ),
            }
        ],
    },
    "generatedAt": "2026-10-21T09:30:08.000Z",
}
CONTRACT_LAB_REQUESTED_EXAMPLE = b"""{
  "specversion": "1.0",
  "id": "0f6c1d3e-8a2b-4c5d-9e7f-1a2b3c4d5e6f",
  "source": "/patipasaport/medical-record",
  "type": "com.patipasaport.lab_explanation.requested.v1",
  "subject": "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "time": "2026-10-21T09:30:00.000Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:patipasaport:events:LabExplanationRequested:v1",
  "data": {
    "recordId": "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    "title": "Biyokimya paneli",
    "sampledAt": "2026-10-20",
    "species": "CAT",
    "birthDate": "2019-05-01",
    "isBirthDateEstimated": true,
    "items": [
      { "testName": "ALT", "value": "142", "unit": "U/L",
        "referenceRange": "12-130", "flag": "HIGH" },
      { "testName": "Kreatinin", "value": "1.4", "unit": "mg/dL",
        "referenceRange": "0.8-2.4", "flag": "NORMAL" }
    ]
  }
}"""
ENVELOPE_KEYS = [
    "specversion",
    "id",
    "source",
    "type",
    "subject",
    "time",
    "datacontenttype",
    "dataschema",
    "data",
]
CONTRACT_EVENT_TYPES = [
    (
        DOCUMENT_UPLOADED,
        "com.patipasaport.document.uploaded.v1",
        "urn:patipasaport:events:DocumentUploaded:v1",
    ),
    (
        DOCUMENT_PROCESSING_STARTED,
        "com.patipasaport.document.processing_started.v1",
        "urn:patipasaport:events:DocumentProcessingStarted:v1",
    ),
    (
        DOCUMENT_ANALYZED,
        "com.patipasaport.document.analyzed.v1",
        "urn:patipasaport:events:DocumentAnalyzed:v1",
    ),
    (
        DOCUMENT_ANALYSIS_FAILED,
        "com.patipasaport.document.analysis_failed.v1",
        "urn:patipasaport:events:DocumentAnalysisFailed:v1",
    ),
    (
        LAB_EXPLANATION_REQUESTED,
        "com.patipasaport.lab_explanation.requested.v1",
        "urn:patipasaport:events:LabExplanationRequested:v1",
    ),
    (
        LAB_EXPLANATION_GENERATED,
        "com.patipasaport.lab_explanation.generated.v1",
        "urn:patipasaport:events:LabExplanationGenerated:v1",
    ),
    (
        LAB_EXPLANATION_FAILED,
        "com.patipasaport.lab_explanation.failed.v1",
        "urn:patipasaport:events:LabExplanationFailed:v1",
    ),
]
UPLOADED_DATA = {
    "documentId": DOCUMENT_ID,
    "petId": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    "clinicId": "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
    "storagePath": "3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123467,
    "sha256": FAKE_SHA256,
}
ANALYZED_DATA = {
    "documentId": DOCUMENT_ID,
    "modelVersion": FAKE_MODEL_VERSION,
    "confidence": 0.86,
    "proposal": {
        "type": "LAB_RESULT",
        "title": "Biyokimya paneli",
        "recordedAt": "2026-10-20",
        "labResult": {
            "items": [
                {
                    "testName": "ALT",
                    "value": "142",
                    "unit": "U/L",
                    "referenceRange": "12-130",
                    "flag": "HIGH",
                },
                {"testName": "Glukoz", "value": "95"},
            ],
            "sampledAt": "2026-10-20",
        },
    },
    "analyzedAt": "2026-10-21T09:00:09.000Z",
}
FAILED_BODY = (
    '{"specversion":"1.0","id":"5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b",'
    '"source":"/patipasaport/ai-service",'
    '"type":"com.patipasaport.document.analysis_failed.v1",'
    '"subject":"0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",'
    '"time":"2026-10-21T09:30:00.123Z","datacontenttype":"application/json",'
    '"dataschema":"urn:patipasaport:events:DocumentAnalysisFailed:v1",'
    '"data":{"documentId":"0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",'
    '"modelVersion":"sahte-model/extract-v1","errorCode":"NOT_A_MEDICAL_DOCUMENT",'
    '"errorMessage":"Belgede kayıt çıkarılacak tıbbi bilgi bulunamadı",'
    '"failedAt":"2026-10-21T09:00:07.000Z"}}'
).encode()
CONTRACT_UPLOADED_EXAMPLE = b"""{
  "specversion": "1.0",
  "id": "5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b",
  "source": "/patipasaport/medical-record",
  "type": "com.patipasaport.document.uploaded.v1",
  "subject": "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
  "time": "2026-10-21T09:00:00.000Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:patipasaport:events:DocumentUploaded:v1",
  "data": {
    "documentId": "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
    "petId": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    "clinicId": "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
    "storagePath": "3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123467,
    "sha256": "9f2c...(64 karakter)"
  }
}"""
BAD_IDS = {
    "uuid-v1": "0dfc0a17-8fb6-1f0b-9732-6a8ca67465de",
    "yanlis-varyant": "0dfc0a17-8fb6-4f0b-c732-6a8ca67465de",
    "tiresiz": "0dfc0a178fb64f0b97326a8ca67465de",
    "suslu-parantezli": "{0dfc0a17-8fb6-4f0b-9732-6a8ca67465de}",
    "sonda-satir-sonu": DOCUMENT_ID + "\n",
    "hex-disi-harf": "0dfc0a17-8fb6-4f0b-9732-6a8ca67465dg",
    "tam-genislik-rakam": chr(0xFF10) + "dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
    "gizli-isaret": SECRET_MARKER,
}


# Sözleşme örneğindeki alanlarla dolu bir DocumentUploaded üretir.
def uploaded_message() -> events_pb2.DocumentUploaded:
    return events_pb2.DocumentUploaded(
        document_id=DOCUMENT_ID,
        pet_id="1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
        clinic_id="6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
        storage_path="3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
        mime_type="application/pdf",
        size_bytes=123467,
        sha256=FAKE_SHA256,
    )


# Tahlil önerili, bazı alanları varsayılan bırakılmış bir DocumentAnalyzed üretir.
def analyzed_message() -> events_pb2.DocumentAnalyzed:
    return events_pb2.DocumentAnalyzed(
        document_id=DOCUMENT_ID,
        model_version=FAKE_MODEL_VERSION,
        confidence=0.86,
        proposal=medical_record_pb2.RecordContent(
            type=medical_record_pb2.RecordType.LAB_RESULT,
            title="Biyokimya paneli",
            recorded_at="2026-10-20",
            lab_result=medical_record_pb2.LabResultDetails(
                items=[
                    medical_record_pb2.LabResultItem(
                        test_name="ALT",
                        value="142",
                        unit="U/L",
                        reference_range="12-130",
                        flag=medical_record_pb2.LabResultFlag.HIGH,
                    ),
                    medical_record_pb2.LabResultItem(test_name="Glukoz", value="95"),
                ],
                sampled_at="2026-10-20",
            ),
        ),
        analyzed_at="2026-10-21T09:00:09.000Z",
    )


# Türkçe hata metni içeren bir DocumentAnalysisFailed üretir.
def failed_message() -> events_pb2.DocumentAnalysisFailed:
    return events_pb2.DocumentAnalysisFailed(
        document_id=DOCUMENT_ID,
        model_version=FAKE_MODEL_VERSION,
        error_code="NOT_A_MEDICAL_DOCUMENT",
        error_message="Belgede kayıt çıkarılacak tıbbi bilgi bulunamadı",
        failed_at="2026-10-21T09:00:07.000Z",
    )


# Sözleşme 16.1'deki alanlarla dolu bir LabExplanationRequested üretir.
def lab_requested_message() -> events_pb2.LabExplanationRequested:
    return events_pb2.LabExplanationRequested(
        record_id=RECORD_ID,
        title="Biyokimya paneli",
        sampled_at="2026-10-20",
        species="CAT",
        birth_date="2019-05-01",
        is_birth_date_estimated=True,
        items=[
            medical_record_pb2.LabResultItem(
                test_name="ALT",
                value="142",
                unit="U/L",
                reference_range="12-130",
                flag=medical_record_pb2.LabResultFlag.HIGH,
            ),
            medical_record_pb2.LabResultItem(
                test_name="Kreatinin",
                value="1.4",
                unit="mg/dL",
                reference_range="0.8-2.4",
                flag=medical_record_pb2.LabResultFlag.NORMAL,
            ),
        ],
    )


# Sözleşme 16.1'deki alanlarla dolu bir LabExplanationGenerated üretir.
def lab_generated_message() -> events_pb2.LabExplanationGenerated:
    return events_pb2.LabExplanationGenerated(
        record_id=RECORD_ID,
        model_version=LAB_GENERATED_DATA["modelVersion"],
        confidence=LAB_GENERATED_DATA["confidence"],
        explanation=medical_record_pb2.LabExplanation(
            summary=LAB_GENERATED_DATA["explanation"]["summary"],
            items=[
                medical_record_pb2.LabExplanationItem(
                    test_name="ALT",
                    explanation=LAB_GENERATED_DATA["explanation"]["items"][0][
                        "explanation"
                    ],
                )
            ],
        ),
        generated_at=LAB_GENERATED_DATA["generatedAt"],
    )


# Verilen tür için alanları dolu örnek proto mesajını döndürür.
def sample_message(event_type: str) -> Message:
    samples: dict[str, Message] = {
        DOCUMENT_UPLOADED: uploaded_message(),
        DOCUMENT_PROCESSING_STARTED: events_pb2.DocumentProcessingStarted(
            document_id=DOCUMENT_ID,
            model_version=FAKE_MODEL_VERSION,
            started_at="2026-10-21T09:00:01.000Z",
        ),
        DOCUMENT_ANALYZED: analyzed_message(),
        DOCUMENT_ANALYSIS_FAILED: failed_message(),
        LAB_EXPLANATION_REQUESTED: lab_requested_message(),
        LAB_EXPLANATION_GENERATED: lab_generated_message(),
        LAB_EXPLANATION_FAILED: events_pb2.LabExplanationFailed(
            record_id=RECORD_ID,
            model_version=LAB_GENERATED_DATA["modelVersion"],
            error_code="AI_PROVIDER_UNAVAILABLE",
            error_message="AI API'ye 5 denemede ulaşılamadı",
            failed_at="2026-10-21T09:32:30.000Z",
        ),
    }
    return samples[event_type]


# Geçerli bir document.uploaded zarfı üretir; alanları değiştirir, MISSING'i siler.
def make_envelope(**changes: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "specversion": "1.0",
        "id": EVENT_ID,
        "source": "/patipasaport/medical-record",
        "type": DOCUMENT_UPLOADED,
        "subject": DOCUMENT_ID,
        "time": "2026-10-21T09:00:00.000Z",
        "datacontenttype": "application/json",
        "dataschema": "urn:patipasaport:events:DocumentUploaded:v1",
        "data": dict(UPLOADED_DATA),
    }
    envelope.update(changes)
    return {key: value for key, value in envelope.items() if value is not MISSING}


# Değeri UTF-8 JSON gövdesine çevirir.
def encode(value: object) -> bytes:
    return json.dumps(value).encode("utf-8")


# Belge verisinin verilen alanlarını değiştirip gövde üretir; MISSING alanı siler.
def uploaded_body(subject: object = DOCUMENT_ID, **data_changes: Any) -> bytes:
    data = {**UPLOADED_DATA, **data_changes}
    data = {key: value for key, value in data.items() if value is not MISSING}
    return encode(make_envelope(subject=subject, data=data))


# Tahlil açıklaması isteğinin alanlarını değiştirip gövde üretir; MISSING alanı siler.
def lab_requested_body(subject: object = RECORD_ID, **data_changes: Any) -> bytes:
    data = {**LAB_REQUESTED_DATA, **data_changes}
    data = {key: value for key, value in data.items() if value is not MISSING}
    return encode(
        make_envelope(
            type=LAB_EXPLANATION_REQUESTED,
            dataschema=DATASCHEMAS[LAB_EXPLANATION_REQUESTED],
            subject=subject,
            data=data,
        )
    )


# Verilen veriyle document.analyzed türünde bir zarfı gövdeye çevirir.
def analyzed_body(data: object) -> bytes:
    return encode(
        make_envelope(
            type=DOCUMENT_ANALYZED,
            dataschema=DATASCHEMAS[DOCUMENT_ANALYZED],
            data=data,
        )
    )


# Geçersiz mesaj durumunu gövde, beklenen tür ve neden koduyla parametre yapar.
def invalid(
    case_id: str, body: bytes, reason: str, expected_type: str = DOCUMENT_UPLOADED
) -> Any:
    return pytest.param(body, expected_type, reason, id=case_id)


# Hatanın yalnızca neden kodunu taşıdığını ve girdi değeri sızdırmadığını doğrular.
def assert_reason_only(error: InvalidMessageError, reason: str) -> None:
    rendered = "".join(traceback.format_exception(error))
    assert error.reason == reason
    assert error.args == (reason,)
    assert str(error) == reason
    assert error.__cause__ is None
    assert error.__context__ is None or error.__suppress_context__
    assert SECRET_MARKER not in rendered


INVALID_CASES = [
    invalid("json-degil-duz-metin", SECRET_MARKER.encode(), "NOT_JSON"),
    invalid("json-degil-yarim", f'{{"id": "{SECRET_MARKER}"'.encode(), "NOT_JSON"),
    invalid("json-degil-bos", b"", "NOT_JSON"),
    invalid(
        "json-degil-utf8-hatali",
        b'{"id": "\xff' + SECRET_MARKER.encode() + b'"}',
        "NOT_JSON",
    ),
    invalid(
        "json-degil-utf16", json.dumps(make_envelope()).encode("utf-16"), "NOT_JSON"
    ),
    invalid("json-degil-bom", b"\xef\xbb\xbf" + encode(make_envelope()), "NOT_JSON"),
    invalid("json-degil-nan", b'{"specversion": NaN}', "NOT_JSON"),
    invalid("json-degil-cok-derin", b"[" * 200_000 + b"]" * 200_000, "NOT_JSON"),
    invalid("nesne-degil-dizi", encode([SECRET_MARKER]), "INVALID_ENVELOPE"),
    invalid("nesne-degil-metin", encode(SECRET_MARKER), "INVALID_ENVELOPE"),
    invalid("nesne-degil-sayi", b"42", "INVALID_ENVELOPE"),
    invalid("nesne-degil-null", b"null", "INVALID_ENVELOPE"),
    invalid(
        "specversion-farkli",
        encode(make_envelope(specversion="0.3")),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "specversion-gizli",
        encode(make_envelope(specversion=SECRET_MARKER)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "specversion-sayi",
        encode(make_envelope(specversion=1.0)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "specversion-yok",
        encode(make_envelope(specversion=MISSING)),
        "INVALID_ENVELOPE",
    ),
    invalid("id-bos", encode(make_envelope(id="")), "INVALID_ENVELOPE"),
    invalid("id-bosluk", encode(make_envelope(id="   ")), "INVALID_ENVELOPE"),
    invalid("id-sayi", encode(make_envelope(id=123)), "INVALID_ENVELOPE"),
    invalid("id-yok", encode(make_envelope(id=MISSING)), "INVALID_ENVELOPE"),
    invalid("source-bos", encode(make_envelope(source="")), "INVALID_ENVELOPE"),
    invalid(
        "source-dizi",
        encode(make_envelope(source=[SECRET_MARKER])),
        "INVALID_ENVELOPE",
    ),
    invalid("source-yok", encode(make_envelope(source=MISSING)), "INVALID_ENVELOPE"),
    invalid("subject-bos", encode(make_envelope(subject="")), "INVALID_ENVELOPE"),
    invalid("subject-sayi", encode(make_envelope(subject=5)), "INVALID_ENVELOPE"),
    invalid("subject-yok", encode(make_envelope(subject=MISSING)), "INVALID_ENVELOPE"),
    invalid(
        "time-gizli", encode(make_envelope(time=SECRET_MARKER)), "INVALID_ENVELOPE"
    ),
    invalid("time-bos", encode(make_envelope(time="")), "INVALID_ENVELOPE"),
    invalid(
        "time-gecersiz-tarih",
        encode(make_envelope(time="2026-13-45T00:00:00Z")),
        "INVALID_ENVELOPE",
    ),
    invalid("time-sayi", encode(make_envelope(time=1761037200)), "INVALID_ENVELOPE"),
    invalid("time-null", encode(make_envelope(time=None)), "INVALID_ENVELOPE"),
    invalid("time-yok", encode(make_envelope(time=MISSING)), "INVALID_ENVELOPE"),
    invalid(
        "time-utc-tasmasi",
        encode(make_envelope(time="0001-01-01T00:00:00+03:00")),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "datacontenttype-farkli",
        encode(make_envelope(datacontenttype="text/plain")),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "datacontenttype-charset",
        encode(make_envelope(datacontenttype="application/json; charset=utf-8")),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "datacontenttype-yok",
        encode(make_envelope(datacontenttype=MISSING)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "data-metin", encode(make_envelope(data=SECRET_MARKER)), "INVALID_ENVELOPE"
    ),
    invalid("data-dizi", encode(make_envelope(data=[])), "INVALID_ENVELOPE"),
    invalid("data-null", encode(make_envelope(data=None)), "INVALID_ENVELOPE"),
    invalid("data-yok", encode(make_envelope(data=MISSING)), "INVALID_ENVELOPE"),
    invalid("type-gizli", encode(make_envelope(type=SECRET_MARKER)), "UNEXPECTED_TYPE"),
    invalid("type-yok", encode(make_envelope(type=MISSING)), "UNEXPECTED_TYPE"),
    invalid(
        "type-dizi",
        encode(make_envelope(type=[DOCUMENT_UPLOADED])),
        "UNEXPECTED_TYPE",
    ),
    invalid(
        "type-baska-kayitli-tur",
        encode(
            make_envelope(
                type=DOCUMENT_ANALYZED, dataschema=DATASCHEMAS[DOCUMENT_ANALYZED]
            )
        ),
        "UNEXPECTED_TYPE",
    ),
    invalid(
        "type-kayit-defterinde-yok",
        encode(
            make_envelope(
                type=UNREGISTERED_TYPE,
                dataschema="urn:patipasaport:events:Unknown:v1",
            )
        ),
        "UNEXPECTED_TYPE",
        UNREGISTERED_TYPE,
    ),
    invalid(
        "lab-turu-belge-kuyrugunda",
        lab_requested_body(),
        "UNEXPECTED_TYPE",
    ),
    invalid(
        "dataschema-gizli",
        encode(make_envelope(dataschema=SECRET_MARKER)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "dataschema-yok",
        encode(make_envelope(dataschema=MISSING)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "dataschema-baska-tur",
        encode(make_envelope(dataschema=DATASCHEMAS[DOCUMENT_ANALYZED])),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "dataschema-kucuk-harf",
        encode(make_envelope(dataschema="urn:patipasaport:events:documentuploaded:v1")),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "veri-tamsayi-gizli", uploaded_body(sizeBytes=SECRET_MARKER), "INVALID_DATA"
    ),
    invalid("veri-tamsayi-kesirli", uploaded_body(sizeBytes=1.5), "INVALID_DATA"),
    invalid("veri-tamsayi-aralik-disi", uploaded_body(sizeBytes=2**40), "INVALID_DATA"),
    invalid("veri-metin-yerine-sayi", uploaded_body(storagePath=123), "INVALID_DATA"),
    invalid(
        "veri-eslenmemis-vekil", uploaded_body(storagePath="\ud800"), "INVALID_DATA"
    ),
    invalid(
        "veri-double-tasmasi",
        analyzed_body({"documentId": DOCUMENT_ID, "confidence": 10**400}),
        "INVALID_DATA",
        DOCUMENT_ANALYZED,
    ),
    invalid(
        "veri-enum-sonsuz",
        analyzed_body(
            {"documentId": DOCUMENT_ID, "proposal": {"type": "SONSUZ"}}
        ).replace(b'"SONSUZ"', b"1e400"),
        "INVALID_DATA",
        DOCUMENT_ANALYZED,
    ),
    invalid(
        "veri-iki-oneof",
        analyzed_body(
            {
                "documentId": DOCUMENT_ID,
                "proposal": {"vaccination": {}, "labResult": {}},
            }
        ),
        "INVALID_DATA",
        DOCUMENT_ANALYZED,
    ),
    invalid("kimlik-alani-yok", uploaded_body(documentId=MISSING), "INVALID_ID"),
    *[
        invalid(
            f"kimlik-{name}",
            uploaded_body(subject=value, documentId=value),
            "INVALID_ID",
        )
        for name, value in BAD_IDS.items()
    ],
    invalid(
        "subject-baska-uuid",
        uploaded_body(subject=OTHER_DOCUMENT_ID),
        "SUBJECT_MISMATCH",
    ),
    invalid("subject-gizli", uploaded_body(subject=SECRET_MARKER), "SUBJECT_MISMATCH"),
    invalid(
        "subject-buyuk-harf",
        uploaded_body(subject=DOCUMENT_ID.upper()),
        "SUBJECT_MISMATCH",
    ),
    invalid(
        "subject-bosluklu",
        uploaded_body(subject=f" {DOCUMENT_ID} "),
        "SUBJECT_MISMATCH",
    ),
    invalid(
        "lab-kimlik-alani-yok",
        lab_requested_body(recordId=MISSING),
        "INVALID_ID",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-kimlik-uuid-v1",
        lab_requested_body(subject=BAD_IDS["uuid-v1"], recordId=BAD_IDS["uuid-v1"]),
        "INVALID_ID",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-subject-baska-uuid",
        lab_requested_body(subject=OTHER_DOCUMENT_ID),
        "SUBJECT_MISMATCH",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-veri-mantiksal-alan-metin",
        lab_requested_body(isBirthDateEstimated=SECRET_MARKER),
        "INVALID_DATA",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-veri-kalemler-metin",
        lab_requested_body(items=SECRET_MARKER),
        "INVALID_DATA",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-veri-kalem-null",
        lab_requested_body(items=[None]),
        "INVALID_DATA",
        LAB_EXPLANATION_REQUESTED,
    ),
    invalid(
        "lab-dataschema-belge",
        encode(
            make_envelope(
                type=LAB_EXPLANATION_REQUESTED,
                dataschema=DATASCHEMAS[DOCUMENT_UPLOADED],
                subject=RECORD_ID,
                data=dict(LAB_REQUESTED_DATA),
            )
        ),
        "INVALID_ENVELOPE",
        LAB_EXPLANATION_REQUESTED,
    ),
]
PRECEDENCE_CASES = [
    invalid(
        "zarf-turden-once",
        encode(make_envelope(specversion="0.3", type=SECRET_MARKER)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "time-turden-once",
        encode(make_envelope(time=SECRET_MARKER, type=SECRET_MARKER)),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "tur-dataschemadan-once",
        encode(make_envelope(type=SECRET_MARKER, dataschema=SECRET_MARKER)),
        "UNEXPECTED_TYPE",
    ),
    invalid(
        "dataschema-veriden-once",
        encode(
            make_envelope(dataschema=SECRET_MARKER, data={"sizeBytes": SECRET_MARKER})
        ),
        "INVALID_ENVELOPE",
    ),
    invalid(
        "veri-kimlikten-once",
        uploaded_body(documentId=SECRET_MARKER, sizeBytes=SECRET_MARKER),
        "INVALID_DATA",
    ),
    invalid(
        "kimlik-subjectten-once",
        uploaded_body(subject=OTHER_DOCUMENT_ID, documentId=SECRET_MARKER),
        "INVALID_ID",
    ),
]


# Zarf sabitlerinin sözleşme 4.1 ve 4.2'deki değerlerle aynı olduğunu doğrular.
def test_envelope_constants_match_contract() -> None:
    assert SPEC_VERSION == "1.0"
    assert CONTENT_TYPE == "application/cloudevents+json"
    assert DATA_CONTENT_TYPE == "application/json"
    assert SOURCE == "/patipasaport/ai-service"


# Yedi tür sabitinin ve URN'lerinin sözleşme 4.3 ile birebir aynı olduğunu doğrular.
def test_event_types_and_dataschemas_match_contract() -> None:
    for constant, event_type, dataschema in CONTRACT_EVENT_TYPES:
        assert constant == event_type
        assert DATASCHEMAS[event_type] == dataschema
    assert len(DATASCHEMAS) == len(CONTRACT_EVENT_TYPES)


# Kayıt defterindeki yedi türün proto sınıfını ve kimlik alanını doğrular.
def test_event_specs_hold_document_and_lab_types() -> None:
    message_classes = {
        DOCUMENT_UPLOADED: (events_pb2.DocumentUploaded, "document_id"),
        DOCUMENT_PROCESSING_STARTED: (
            events_pb2.DocumentProcessingStarted,
            "document_id",
        ),
        DOCUMENT_ANALYZED: (events_pb2.DocumentAnalyzed, "document_id"),
        DOCUMENT_ANALYSIS_FAILED: (events_pb2.DocumentAnalysisFailed, "document_id"),
        LAB_EXPLANATION_REQUESTED: (events_pb2.LabExplanationRequested, "record_id"),
        LAB_EXPLANATION_GENERATED: (events_pb2.LabExplanationGenerated, "record_id"),
        LAB_EXPLANATION_FAILED: (events_pb2.LabExplanationFailed, "record_id"),
    }

    assert list(EVENT_SPECS) == list(message_classes)
    assert set(EVENT_SPECS) == set(DATASCHEMAS)
    for event_type, (message_class, id_field) in message_classes.items():
        assert EVENT_SPECS[event_type] == EventSpec(
            type=event_type,
            dataschema=DATASCHEMAS[event_type],
            message_class=message_class,
            id_field=id_field,
        )


# Tür ve kayıt sözlüklerinin çalışma anında değiştirilemediğini doğrular.
def test_registries_are_read_only() -> None:
    schemas: Any = DATASCHEMAS
    specs: Any = EVENT_SPECS

    with pytest.raises(TypeError):
        schemas[DOCUMENT_UPLOADED] = SECRET_MARKER
    with pytest.raises(TypeError):
        specs[LAB_EXPLANATION_REQUESTED] = EVENT_SPECS[DOCUMENT_UPLOADED]


# Dört belge türünde build_event çıktısının parse_event ile aynen okunduğunu doğrular.
@pytest.mark.parametrize("event_type", DOCUMENT_TYPES)
def test_build_then_parse_round_trip(event_type: str) -> None:
    message = sample_message(event_type)

    built = build_event(message, event_type, now=FIXED_NOW, event_id=EVENT_ID)
    parsed = parse_event(built.body, event_type)

    assert parsed == IncomingEvent(
        id=EVENT_ID,
        type=event_type,
        source=SOURCE,
        subject=DOCUMENT_ID,
        time=FIXED_NOW,
        data=message,
    )
    assert type(parsed.data) is type(message)


# Üç tahlil açıklaması türünde zarfın recordId ile kurulup aynen okunduğunu doğrular.
@pytest.mark.parametrize("event_type", LAB_TYPES)
def test_lab_build_then_parse_round_trip(event_type: str) -> None:
    message = sample_message(event_type)

    built = build_event(message, event_type, now=FIXED_NOW, event_id=EVENT_ID)
    parsed = parse_event(built.body, event_type)

    assert built.subject == RECORD_ID
    assert json.loads(built.body)["dataschema"] == DATASCHEMAS[event_type]
    assert parsed == IncomingEvent(
        id=EVENT_ID,
        type=event_type,
        source=SOURCE,
        subject=RECORD_ID,
        time=FIXED_NOW,
        data=message,
    )


# Sözleşme 16.1'deki lab_explanation.requested örneğinin eksiksiz okunduğunu doğrular.
def test_parse_event_reads_contract_lab_requested_example() -> None:
    event = parse_event(CONTRACT_LAB_REQUESTED_EXAMPLE, LAB_EXPLANATION_REQUESTED)

    assert event == IncomingEvent(
        id="0f6c1d3e-8a2b-4c5d-9e7f-1a2b3c4d5e6f",
        type=LAB_EXPLANATION_REQUESTED,
        source="/patipasaport/medical-record",
        subject=RECORD_ID,
        time=datetime(2026, 10, 21, 9, 30, tzinfo=UTC),
        data=lab_requested_message(),
    )


# generated olayının data'sının sözleşme 16.1'deki örnekle aynı olduğunu doğrular.
def test_build_event_writes_contract_lab_generated_data() -> None:
    event = build_event(
        lab_generated_message(),
        LAB_EXPLANATION_GENERATED,
        now=FIXED_NOW,
        event_id=EVENT_ID,
    )

    envelope = json.loads(event.body)
    assert envelope["type"] == "com.patipasaport.lab_explanation.generated.v1"
    assert envelope["subject"] == RECORD_ID
    assert envelope["dataschema"] == (
        "urn:patipasaport:events:LabExplanationGenerated:v1"
    )
    assert envelope["data"] == LAB_GENERATED_DATA


# Zarf alanlarının sözleşmedeki sırayla ve doğru değerlerle yazıldığını doğrular.
def test_build_event_writes_envelope_fields_in_order() -> None:
    event = build_event(
        uploaded_message(), DOCUMENT_UPLOADED, now=FIXED_NOW, event_id=EVENT_ID
    )
    envelope = json.loads(event.body)

    assert list(envelope) == ENVELOPE_KEYS
    assert envelope == {
        "specversion": "1.0",
        "id": EVENT_ID,
        "source": "/patipasaport/ai-service",
        "type": "com.patipasaport.document.uploaded.v1",
        "subject": DOCUMENT_ID,
        "time": FIXED_TIME_TEXT,
        "datacontenttype": "application/json",
        "dataschema": "urn:patipasaport:events:DocumentUploaded:v1",
        "data": UPLOADED_DATA,
    }
    assert event == OutgoingEvent(
        id=EVENT_ID, type=DOCUMENT_UPLOADED, subject=DOCUMENT_ID, body=event.body
    )


# Gövdenin boşluksuz ayraçlı ve Türkçe karakterleri kaçışsız UTF-8 olduğunu doğrular.
def test_build_event_body_is_compact_utf8_json() -> None:
    event = build_event(
        failed_message(), DOCUMENT_ANALYSIS_FAILED, now=FIXED_NOW, event_id=EVENT_ID
    )

    assert event.body == FAILED_BODY


# id ve now verilmezse yeni bir UUID v4 ve şimdiki UTC zamanın kullanıldığını doğrular.
def test_build_event_defaults_to_new_uuid4_and_current_time() -> None:
    before = datetime.now(UTC)
    first = build_event(uploaded_message(), DOCUMENT_UPLOADED)
    second = build_event(uploaded_message(), DOCUMENT_UPLOADED)
    after = datetime.now(UTC)
    envelope = json.loads(first.body)

    assert UUID_V4_LOWER.fullmatch(first.id)
    assert uuid.UUID(first.id).version == 4
    assert envelope["id"] == first.id
    assert first.id != second.id
    assert ISO_UTC_MILLIS.fullmatch(envelope["time"])
    sent_at = datetime.fromisoformat(envelope["time"])
    assert before - timedelta(milliseconds=1) <= sent_at <= after


# now'un UTC'de milisaniyeli yazıldığını ve dilimsiz now'un UTC sayıldığını doğrular.
@pytest.mark.parametrize(
    ("now", "expected"),
    [
        pytest.param(
            datetime(2026, 10, 21, 12, 30, 0, 123999, timezone(timedelta(hours=3))),
            "2026-10-21T09:30:00.123Z",
            id="istanbul-saati",
        ),
        pytest.param(
            datetime(2026, 10, 21, 9, 30),
            "2026-10-21T09:30:00.000Z",
            id="zaman-dilimsiz",
        ),
    ],
)
def test_build_event_formats_time_as_utc_milliseconds(
    now: datetime, expected: str
) -> None:
    event = build_event(uploaded_message(), DOCUMENT_UPLOADED, now=now)

    assert json.loads(event.body)["time"] == expected


# data'nın camelCase alan adları ve enum adlarıyla yazıldığını doğrular.
def test_build_event_data_uses_camel_case_and_enum_names() -> None:
    event = build_event(
        analyzed_message(), DOCUMENT_ANALYZED, now=FIXED_NOW, event_id=EVENT_ID
    )
    data = json.loads(event.body)["data"]

    assert data == ANALYZED_DATA
    assert "notes" not in data["proposal"]
    assert "flag" not in data["proposal"]["labResult"]["items"][1]


# Varsayılan değerli alanların (boş metin, 0, belirsiz enum) yazılmadığını doğrular.
def test_build_event_omits_default_valued_fields() -> None:
    message = events_pb2.DocumentAnalyzed(
        document_id=DOCUMENT_ID,
        confidence=0.0,
        proposal=medical_record_pb2.RecordContent(
            type=medical_record_pb2.RecordType.EXAMINATION, title="Genel muayene"
        ),
    )

    event = build_event(message, DOCUMENT_ANALYZED, now=FIXED_NOW, event_id=EVENT_ID)

    assert json.loads(event.body)["data"] == {
        "documentId": DOCUMENT_ID,
        "proposal": {"type": "EXAMINATION", "title": "Genel muayene"},
    }


# Kayıtsız tür, yanlış sınıf ve boş kimlikte ValueError verildiğini doğrular.
@pytest.mark.parametrize(
    ("data", "event_type"),
    [
        pytest.param(uploaded_message(), "com.patipasaport.unknown.v1", id="tur-yok"),
        pytest.param(
            analyzed_message(), LAB_EXPLANATION_GENERATED, id="lab-turu-yanlis-sinif"
        ),
        pytest.param(
            events_pb2.LabExplanationFailed(record_id=" "),
            LAB_EXPLANATION_FAILED,
            id="lab-bosluk-kimlik",
        ),
        pytest.param(uploaded_message(), DOCUMENT_ANALYZED, id="yanlis-sinif"),
        pytest.param(dict(UPLOADED_DATA), DOCUMENT_UPLOADED, id="proto-degil"),
        pytest.param(events_pb2.DocumentUploaded(), DOCUMENT_UPLOADED, id="bos-kimlik"),
        pytest.param(
            events_pb2.DocumentProcessingStarted(document_id="   "),
            DOCUMENT_PROCESSING_STARTED,
            id="bosluk-kimlik",
        ),
    ],
)
def test_build_event_rejects_programming_errors(data: Any, event_type: str) -> None:
    with pytest.raises(ValueError):
        build_event(data, event_type, now=FIXED_NOW, event_id=EVENT_ID)


# Sözleşme 16.1'deki document.uploaded örneğinin eksiksiz okunduğunu doğrular.
def test_parse_event_reads_contract_document_uploaded_example() -> None:
    event = parse_event(CONTRACT_UPLOADED_EXAMPLE, DOCUMENT_UPLOADED)

    assert event == IncomingEvent(
        id="5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b",
        type=DOCUMENT_UPLOADED,
        source="/patipasaport/medical-record",
        subject=DOCUMENT_ID,
        time=datetime(2026, 10, 21, 9, 0, tzinfo=UTC),
        data=events_pb2.DocumentUploaded(
            document_id=DOCUMENT_ID,
            pet_id="1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
            clinic_id="6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
            storage_path="3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
            mime_type="application/pdf",
            size_bytes=123467,
            sha256="9f2c...(64 karakter)",
        ),
    )
    assert event.time.tzinfo is UTC


# snake_case alanların okunduğunu, bilinmeyen alanların yok sayıldığını doğrular.
def test_parse_event_accepts_snake_case_and_ignores_unknown_fields() -> None:
    envelope = make_envelope(
        traceparent="00-sahte-iz-01",
        data={
            "document_id": DOCUMENT_ID,
            "pet_id": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
            "clinic_id": "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
            "storage_path": "3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 123467,
            "sha256": FAKE_SHA256,
            "futureField": {"nested": [1, 2, 3]},
        },
    )

    event = parse_event(encode(envelope), DOCUMENT_UPLOADED)

    assert event.data == uploaded_message()


# Enum'ların adla ve sayıyla, iç içe alanların iki yazımla da okunduğunu doğrular.
def test_parse_event_accepts_enum_names_and_numbers() -> None:
    data = {
        "document_id": DOCUMENT_ID,
        "proposal": {
            "type": 4,
            "lab_result": {
                "items": [
                    {"test_name": "ALT", "flag": 3},
                    {"testName": "Kreatinin", "flag": "NORMAL"},
                ]
            },
        },
    }

    event = parse_event(analyzed_body(data), DOCUMENT_ANALYZED)

    assert event.data == events_pb2.DocumentAnalyzed(
        document_id=DOCUMENT_ID,
        proposal=medical_record_pb2.RecordContent(
            type=medical_record_pb2.RecordType.LAB_RESULT,
            lab_result=medical_record_pb2.LabResultDetails(
                items=[
                    medical_record_pb2.LabResultItem(
                        test_name="ALT", flag=medical_record_pb2.LabResultFlag.HIGH
                    ),
                    medical_record_pb2.LabResultItem(
                        test_name="Kreatinin",
                        flag=medical_record_pb2.LabResultFlag.NORMAL,
                    ),
                ]
            ),
        ),
    )


# Tanınmayan flag adının ParseDict ile UNSPECIFIED olarak okunduğunu doğrular.
def test_unknown_flag_name_is_read_as_unspecified() -> None:
    body = lab_requested_body(items=[{"testName": "ALT", "flag": SECRET_MARKER}])

    event = parse_event(body, LAB_EXPLANATION_REQUESTED)

    assert isinstance(event.data, events_pb2.LabExplanationRequested)
    [item] = event.data.items
    assert item.flag == medical_record_pb2.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED


# Büyük harfli UUID v4 kimliğin subject ile birebir aynıysa kabul edildiğini doğrular.
def test_parse_event_accepts_uppercase_uuid_matching_subject() -> None:
    upper_id = DOCUMENT_ID.upper()

    event = parse_event(
        uploaded_body(subject=upper_id, documentId=upper_id), DOCUMENT_UPLOADED
    )

    assert event.subject == upper_id
    assert isinstance(event.data, events_pb2.DocumentUploaded)
    assert event.data.document_id == upper_id


# Zaman yazımlarının UTC'ye çevrildiğini, dilimsiz zamanın UTC sayıldığını doğrular.
@pytest.mark.parametrize(
    "time_text",
    ["2026-10-21T09:00:00.000Z", "2026-10-21T12:00:00+03:00", "2026-10-21T09:00:00"],
)
def test_parse_event_normalizes_time_to_utc(time_text: str) -> None:
    event = parse_event(encode(make_envelope(time=time_text)), DOCUMENT_UPLOADED)

    assert event.time == datetime(2026, 10, 21, 9, 0, tzinfo=UTC)
    assert event.time.tzinfo is UTC


# Geçersiz her mesajın doğru kodla, girdi değeri sızdırmadan reddedildiğini doğrular.
@pytest.mark.parametrize(("body", "expected_type", "reason"), INVALID_CASES)
def test_parse_event_rejects_invalid_messages(
    body: bytes, expected_type: str, reason: str
) -> None:
    with pytest.raises(InvalidMessageError) as excinfo:
        parse_event(body, expected_type)

    assert_reason_only(excinfo.value, reason)


# Birden çok kural bozulunca doğrulamaların sözleşmedeki sırayla yapıldığını doğrular.
@pytest.mark.parametrize(("body", "expected_type", "reason"), PRECEDENCE_CASES)
def test_parse_event_applies_checks_in_contract_order(
    body: bytes, expected_type: str, reason: str
) -> None:
    with pytest.raises(InvalidMessageError) as excinfo:
        parse_event(body, expected_type)

    assert_reason_only(excinfo.value, reason)
