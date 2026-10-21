import subprocess
import sys
from pathlib import Path

import pytest
from google.protobuf import json_format

from app.generated import events_pb2, medical_record_pb2

SERVICE_DIR = Path(__file__).resolve().parents[2]
FAKE_SHA256 = "0123456789abcdef" * 4
UPLOADED_DATA = {
    "documentId": "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
    "petId": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    "clinicId": "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
    "storagePath": "3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123467,
    "sha256": FAKE_SHA256,
}
UPLOADED_DATA_SNAKE_CASE = {
    "document_id": "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
    "pet_id": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    "clinic_id": "6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
    "storage_path": "3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 123467,
    "sha256": FAKE_SHA256,
}
FRESH_INTERPRETER_CODE = (
    "from importlib.util import find_spec\n"
    "assert find_spec('events') is None\n"
    "from app.generated import events_pb2, medical_record_pb2\n"
)


# app.generated'ın dışa aktardığı modüllerin tek kopya olarak yüklendiğini doğrular.
def test_generated_package_exports_single_module_copies() -> None:
    assert sys.modules["events.events_pb2"] is events_pb2
    assert sys.modules["medical_record.medical_record_pb2"] is medical_record_pb2
    assert events_pb2.DESCRIPTOR.name == "events/events.proto"
    assert medical_record_pb2.DESCRIPTOR.name == "medical_record/medical_record.proto"


# Temiz yorumlayıcıda events'in ancak app.generated üzerinden yüklendiğini doğrular.
def test_package_import_works_in_fresh_interpreter() -> None:
    result = subprocess.run(
        [sys.executable, "-E", "-c", FRESH_INTERPRETER_CODE],
        cwd=SERVICE_DIR,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


# MessageToDict'in lowerCamelCase anahtar ve enum adı ürettiğini doğrular.
def test_document_analyzed_to_dict_uses_camel_case_and_enum_names() -> None:
    item = medical_record_pb2.LabResultItem(
        test_name="ALT",
        value="142",
        unit="U/L",
        reference_range="12-130",
        flag=medical_record_pb2.LabResultFlag.HIGH,
    )
    message = events_pb2.DocumentAnalyzed(
        document_id="0dfc0a17-8fb6-4f0b-9732-6a8ca67465de",
        model_version="gemma-4-31b/extract-v1",
        confidence=0.86,
        proposal=medical_record_pb2.RecordContent(
            type=medical_record_pb2.RecordType.LAB_RESULT,
            title="Biyokimya paneli",
            lab_result=medical_record_pb2.LabResultDetails(items=[item]),
        ),
        analyzed_at="2026-10-21T09:00:09.000Z",
    )

    data = json_format.MessageToDict(message)
    first_item = data["proposal"]["labResult"]["items"][0]

    assert data["documentId"] == "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
    assert data["modelVersion"] == "gemma-4-31b/extract-v1"
    assert data["proposal"]["type"] == "LAB_RESULT"
    assert first_item["testName"] == "ALT"
    assert first_item["flag"] == "HIGH"


# Sözleşmedeki document.uploaded.v1 verisinin DocumentUploaded'a okunduğunu doğrular.
def test_document_uploaded_parses_contract_example() -> None:
    message = json_format.ParseDict(UPLOADED_DATA, events_pb2.DocumentUploaded())

    assert message.document_id == "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
    assert message.size_bytes == 123467
    assert message.sha256 == FAKE_SHA256
    assert json_format.MessageToDict(message) == UPLOADED_DATA


# Aynı verinin snake_case alan adlarıyla da okunduğunu doğrular.
def test_document_uploaded_parses_snake_case_fields() -> None:
    message = json_format.ParseDict(
        UPLOADED_DATA_SNAKE_CASE, events_pb2.DocumentUploaded()
    )

    assert json_format.MessageToDict(message) == UPLOADED_DATA


# ignore_unknown_fields=True ile bilinmeyen alanın hata vermediğini doğrular.
def test_document_uploaded_ignores_unknown_fields() -> None:
    data = {**UPLOADED_DATA, "futureField": "bilinmeyen"}

    with pytest.raises(json_format.ParseError):
        json_format.ParseDict(data, events_pb2.DocumentUploaded())

    message = json_format.ParseDict(
        data, events_pb2.DocumentUploaded(), ignore_unknown_fields=True
    )

    assert json_format.MessageToDict(message) == UPLOADED_DATA
