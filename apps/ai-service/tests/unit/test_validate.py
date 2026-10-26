import copy
import json
import math
import re
from dataclasses import FrozenInstanceError
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any

import pytest
from google.protobuf import json_format

from app.documents.validate import (
    BUSINESS_TIME_ZONE,
    ExtractionInvalid,
    ExtractionResult,
    ValidationIssue,
    validate_extraction,
)
from app.errors import NOT_A_MEDICAL_DOCUMENT, PermanentError
from app.generated import medical_record_pb2

TODAY = date(2026, 10, 26)
TODAY_TEXT = "2026-10-26"
TOMORROW_TEXT = "2026-10-27"
EVENT_TIME = datetime(2026, 10, 21, 9, 0, tzinfo=UTC)
EVENT_DAY = "2026-10-21"
SECRET_MARKER = "GIZLI-ICERIK-7Q"
MISSING = object()
FULLWIDTH_DATE = "".join(
    chr(0xFF10 + int(part)) if part.isdigit() else part for part in "2026-10-20"
)

CONTRACT_EXAMPLE_TEXT = """
{
  "isMedicalDocument": true,
  "confidence": 0.86,
  "proposal": {
    "type": "LAB_RESULT",
    "title": "Hemogram",
    "notes": "",
    "recordedAt": "2026-10-20",
    "labResult": {
      "sampledAt": "2026-10-20",
      "items": [
        { "testName": "WBC", "value": "12.4", "unit": "10^3/µL",
          "referenceRange": "5.5-19.5", "flag": "NORMAL" }
      ]
    }
  }
}
"""

ANALYZED_EXAMPLE_PROPOSAL: dict[str, Any] = {
    "type": "LAB_RESULT",
    "title": "Biyokimya paneli",
    "recordedAt": "2026-10-20",
    "labResult": {
        "sampledAt": "2026-10-20",
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

TEMPLATES: dict[str, dict[str, Any]] = {
    "lab": json.loads(CONTRACT_EXAMPLE_TEXT),
    "vaccination": {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "VACCINATION",
            "title": "Kuduz aşısı",
            "notes": "",
            "recordedAt": "2026-10-20",
            "labResult": None,
            "vaccination": {
                "vaccineName": "Kuduz",
                "batchNumber": "SERI-001",
                "administeredAt": "2026-10-20",
                "nextDueAt": "2027-10-20",
            },
            "prescription": None,
        },
    },
    "prescription": {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "PRESCRIPTION",
            "title": "Antibiyotik reçetesi",
            "notes": "",
            "recordedAt": "2026-10-20",
            "labResult": None,
            "vaccination": None,
            "prescription": {
                "medicationName": "Amoksisilin",
                "dosage": "250 mg",
                "frequency": "Günde 2 kez",
                "durationDays": 7,
                "instructions": "Yemekten sonra verilir.",
                "prescribedAt": "2026-10-20",
            },
        },
    },
    "examination": {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "EXAMINATION",
            "title": "Genel muayene",
            "notes": "Kontrol muayenesi.",
            "recordedAt": "2026-10-20",
            "labResult": None,
            "vaccination": None,
            "prescription": None,
        },
    },
    "surgery": {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "SURGERY",
            "title": "Kısırlaştırma",
            "notes": "",
            "recordedAt": "2026-10-20",
            "labResult": None,
            "vaccination": None,
            "prescription": None,
        },
    },
}

TEXT_PARAMS = "kind,dotted,required,min_length,max_length,multiline"
TEXT_FIELDS = [
    pytest.param("lab", "proposal.title", True, 2, 128, False, id="title"),
    pytest.param("lab", "proposal.notes", False, 0, 2000, True, id="notes"),
    pytest.param(
        "lab",
        "proposal.labResult.items.0.testName",
        True,
        1,
        128,
        False,
        id="testName",
    ),
    pytest.param(
        "lab", "proposal.labResult.items.0.value", True, 1, 64, False, id="value"
    ),
    pytest.param(
        "lab", "proposal.labResult.items.0.unit", False, 0, 32, False, id="unit"
    ),
    pytest.param(
        "lab",
        "proposal.labResult.items.0.referenceRange",
        False,
        0,
        64,
        False,
        id="referenceRange",
    ),
    pytest.param(
        "vaccination",
        "proposal.vaccination.vaccineName",
        True,
        1,
        128,
        False,
        id="vaccineName",
    ),
    pytest.param(
        "vaccination",
        "proposal.vaccination.batchNumber",
        False,
        0,
        64,
        False,
        id="batchNumber",
    ),
    pytest.param(
        "prescription",
        "proposal.prescription.medicationName",
        True,
        1,
        128,
        False,
        id="medicationName",
    ),
    pytest.param(
        "prescription",
        "proposal.prescription.dosage",
        True,
        1,
        64,
        False,
        id="dosage",
    ),
    pytest.param(
        "prescription",
        "proposal.prescription.frequency",
        True,
        1,
        64,
        False,
        id="frequency",
    ),
    pytest.param(
        "prescription",
        "proposal.prescription.instructions",
        False,
        0,
        1000,
        True,
        id="instructions",
    ),
]

DATE_FIELDS = [
    pytest.param("lab", "proposal.recordedAt", id="lab-recordedAt"),
    pytest.param("lab", "proposal.labResult.sampledAt", id="sampledAt"),
    pytest.param(
        "vaccination", "proposal.vaccination.administeredAt", id="administeredAt"
    ),
    pytest.param(
        "prescription", "proposal.prescription.prescribedAt", id="prescribedAt"
    ),
    pytest.param("examination", "proposal.recordedAt", id="examination-recordedAt"),
    pytest.param("surgery", "proposal.recordedAt", id="surgery-recordedAt"),
]

PAIRED_DATES = [
    pytest.param("lab", "proposal.labResult.sampledAt", id="lab"),
    pytest.param(
        "vaccination", "proposal.vaccination.administeredAt", id="vaccination"
    ),
    pytest.param(
        "prescription", "proposal.prescription.prescribedAt", id="prescription"
    ),
]


# Verilen türdeki geçerli örnek çıktının bağımsız bir kopyasını döndürür.
def _output(kind: str) -> dict[str, Any]:
    return copy.deepcopy(TEMPLATES[kind])


# Çıktıda noktalı yolla gösterilen alanı değiştirir, MISSING verilirse alanı siler.
def _with(output: dict[str, Any], dotted: str, value: object) -> dict[str, Any]:
    keys = [int(part) if part.isdigit() else part for part in dotted.split(".")]
    target: Any = output
    for key in keys[:-1]:
        target = target[key]
    if value is MISSING:
        del target[keys[-1]]
    else:
        target[keys[-1]] = value
    return output


# Noktalı test yolunu doğrulayıcının alan yolu biçimine çevirir.
def _issue_path(dotted: str) -> str:
    return re.sub(r"\.([0-9]+)", r"[\1]", dotted)


# Çıktıyı sabit bugün ve olay zamanıyla doğrular.
def _ok(
    output: object, *, today: date = TODAY, event_time: datetime = EVENT_TIME
) -> ExtractionResult:
    return validate_extraction(output, event_time=event_time, today=today)


# Çıktının reddedildiğini doğrular ve bulunan sorunları döndürür.
def _issues(
    output: object, *, today: date = TODAY, event_time: datetime = EVENT_TIME
) -> tuple[ValidationIssue, ...]:
    with pytest.raises(ExtractionInvalid) as caught:
        validate_extraction(output, event_time=event_time, today=today)
    return caught.value.issues


# Tek bir sorun beklenen durumlar için karşılaştırma değerini kurar.
def _single(dotted: str, code: str) -> tuple[ValidationIssue, ...]:
    return (ValidationIssue(_issue_path(dotted), code),)


# Sözleşme 6.5'teki örnek ham metin olarak verilince geçerli bir RecordContent olur.
def test_contract_example_becomes_record_content() -> None:
    result = _ok(CONTRACT_EXAMPLE_TEXT)
    assert isinstance(result.proposal, medical_record_pb2.RecordContent)
    assert result.confidence == pytest.approx(0.86)
    assert result.date_estimated is False
    assert result.proposal.WhichOneof("details") == "lab_result"
    assert json_format.MessageToDict(result.proposal) == {
        "type": "LAB_RESULT",
        "title": "Hemogram",
        "recordedAt": "2026-10-20",
        "labResult": {
            "sampledAt": "2026-10-20",
            "items": [
                {
                    "testName": "WBC",
                    "value": "12.4",
                    "unit": "10^3/µL",
                    "referenceRange": "5.5-19.5",
                    "flag": "NORMAL",
                }
            ],
        },
    }


# Sözleşme 16.1'deki analyzed örneğinin proposal'ı ayrıştırılmış çıktıdan aynen kurulur.
def test_analyzed_example_proposal_round_trips() -> None:
    output = {
        "isMedicalDocument": True,
        "confidence": 0.86,
        "proposal": copy.deepcopy(ANALYZED_EXAMPLE_PROPOSAL),
    }
    result = _ok(output)
    assert json_format.MessageToDict(result.proposal) == ANALYZED_EXAMPLE_PROPOSAL
    assert result.proposal.lab_result.items[0].flag == medical_record_pb2.HIGH


# Her türün geçerli örneği kendi türüyle ve yalnızca kendi ayrıntısıyla kurulur.
@pytest.mark.parametrize(
    ("kind", "record_type", "details"),
    [
        ("lab", "LAB_RESULT", "lab_result"),
        ("vaccination", "VACCINATION", "vaccination"),
        ("prescription", "PRESCRIPTION", "prescription"),
        ("examination", "EXAMINATION", None),
        ("surgery", "SURGERY", None),
    ],
)
def test_each_record_type_is_accepted(
    kind: str, record_type: str, details: str | None
) -> None:
    result = _ok(_output(kind))
    assert result.proposal.type == medical_record_pb2.RecordType.Value(record_type)
    assert result.proposal.WhichOneof("details") == details
    assert result.date_estimated is False


# Aşı ve reçete örneklerinin bütün alanları proto'ya doğru aktarılır.
def test_vaccination_and_prescription_fields_are_mapped() -> None:
    vaccination = _ok(_output("vaccination")).proposal.vaccination
    assert (
        vaccination.vaccine_name,
        vaccination.batch_number,
        vaccination.administered_at,
        vaccination.next_due_at,
    ) == ("Kuduz", "SERI-001", "2026-10-20", "2027-10-20")
    prescription = _ok(_output("prescription")).proposal.prescription
    assert (
        prescription.medication_name,
        prescription.dosage,
        prescription.frequency,
        prescription.duration_days,
        prescription.instructions,
        prescription.prescribed_at,
    ) == (
        "Amoksisilin",
        "250 mg",
        "Günde 2 kez",
        7,
        "Yemekten sonra verilir.",
        "2026-10-20",
    )


# JSON olmayan ya da nesne olmayan ham metinleri kök FORMAT sorunuyla reddeder.
@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "merhaba",
        "{",
        pytest.param(
            "```json\n" + CONTRACT_EXAMPLE_TEXT + "\n```", id="markdown-fence"
        ),
        "[1, 2]",
        "null",
        "42",
        '"metin"',
        pytest.param(CONTRACT_EXAMPLE_TEXT.replace("0.86", "NaN"), id="nan"),
        pytest.param(CONTRACT_EXAMPLE_TEXT.replace("0.86", "Infinity"), id="inf"),
        pytest.param(
            CONTRACT_EXAMPLE_TEXT.replace("0.86", "-Infinity"), id="negative-inf"
        ),
        pytest.param("[" * 100000, id="deep-nesting"),
    ],
)
def test_non_json_text_is_format_error(text: str) -> None:
    assert _issues(text) == (ValidationIssue("$", "FORMAT"),)


# Metin ya da sözlük olmayan girdileri kök FORMAT sorunuyla reddeder.
@pytest.mark.parametrize("value", [None, 42, 0.5, True, [1], b"{}", bytearray(b"{}")])
def test_non_object_input_is_format_error(value: object) -> None:
    assert _issues(value) == (ValidationIssue("$", "FORMAT"),)


# JSON metninin başındaki ve sonundaki boşluklar ayrıştırmayı bozmaz.
def test_json_text_with_surrounding_whitespace_is_accepted() -> None:
    assert _ok("\n  " + CONTRACT_EXAMPLE_TEXT + "  \n").confidence == pytest.approx(
        0.86
    )


# isMedicalDocument false ise diğer alanlara bakmadan NOT_A_MEDICAL_DOCUMENT fırlatır.
@pytest.mark.parametrize("proposal", [MISSING, None, "çöp", {"type": "YOK"}])
def test_not_a_medical_document(proposal: object) -> None:
    output: dict[str, Any] = {"isMedicalDocument": False, "confidence": "geçersiz"}
    if proposal is not MISSING:
        output["proposal"] = proposal
    with pytest.raises(PermanentError) as caught:
        _ok(output)
    assert caught.value.code == NOT_A_MEDICAL_DOCUMENT
    with pytest.raises(PermanentError) as caught_text:
        _ok(json.dumps(output))
    assert caught_text.value.code == NOT_A_MEDICAL_DOCUMENT


# Boolean olmayan isMedicalDocument değerlerini TYPE olarak reddeder.
@pytest.mark.parametrize("value", [MISSING, None, "true", "false", 1, 0, [True]])
def test_is_medical_document_must_be_boolean(value: object) -> None:
    output = _with(_output("lab"), "isMedicalDocument", value)
    assert _issues(output) == _single("isMedicalDocument", "TYPE")


# confidence değerini [0, 1] aralığına kırpar.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.86, 0.86),
        (0, 0.0),
        (1, 1.0),
        (0.0, 0.0),
        (1.0, 1.0),
        (1.7, 1.0),
        (-0.3, 0.0),
        (5, 1.0),
        (-2, 0.0),
        (10**400, 1.0),
        (-(10**400), 0.0),
    ],
)
def test_confidence_is_clipped(value: float, expected: float) -> None:
    result = _ok(_with(_output("lab"), "confidence", value))
    assert result.confidence == pytest.approx(expected)
    assert isinstance(result.confidence, float)


# Negatif sıfır confidence pozitif sıfıra çevrilir.
def test_negative_zero_confidence_becomes_zero() -> None:
    result = _ok(_with(_output("lab"), "confidence", -0.0))
    assert math.copysign(1.0, result.confidence) == 1.0


# Sayı olmayan, bool, NaN ve sonsuz confidence değerlerini TYPE olarak reddeder.
@pytest.mark.parametrize(
    "value",
    [
        MISSING,
        None,
        True,
        False,
        "0.8",
        [0.5],
        {"v": 0.5},
        math.nan,
        math.inf,
        -math.inf,
    ],
)
def test_invalid_confidence_is_type_error(value: object) -> None:
    output = _with(_output("lab"), "confidence", value)
    assert _issues(output) == _single("confidence", "TYPE")


# JSON'da taşan sayı sonsuza dönüştüğü için TYPE olarak reddedilir.
def test_overflowing_confidence_text_is_type_error() -> None:
    text = CONTRACT_EXAMPLE_TEXT.replace("0.86", "1e400")
    assert _issues(text) == _single("confidence", "TYPE")


# proposal yoksa ya da nesne değilse uygun sorunu bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [(MISSING, "REQUIRED"), (None, "REQUIRED"), ("metin", "TYPE"), ([], "TYPE")],
)
def test_proposal_must_be_object(value: object, code: str) -> None:
    output = _with(_output("lab"), "proposal", value)
    assert _issues(output) == _single("proposal", code)


# Geçersiz kayıt türlerini uygun kodla reddeder.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("", "REQUIRED"),
        ("   ", "REQUIRED"),
        ("RECORD_TYPE_UNSPECIFIED", "ENUM"),
        ("lab_result", "ENUM"),
        ("TAHLIL", "ENUM"),
        (4, "TYPE"),
        (["LAB_RESULT"], "TYPE"),
    ],
)
def test_invalid_record_type(value: object, code: str) -> None:
    output = _with(_output("lab"), "proposal.type", value)
    assert _issues(output) == _single("proposal.type", code)


# Kayıt türünün baştaki ve sondaki boşlukları kırpılır.
def test_record_type_is_trimmed() -> None:
    result = _ok(_with(_output("lab"), "proposal.type", " LAB_RESULT "))
    assert result.proposal.type == medical_record_pb2.LAB_RESULT


# Metin alanlarının üst sınırını ve bir fazlasını Unicode karakter sayısıyla denetler.
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_text_field_max_length(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
) -> None:
    _ok(_with(_output(kind), dotted, "ş" * max_length))
    output = _with(_output(kind), dotted, "ş" * (max_length + 1))
    assert _issues(output) == _single(dotted, "LENGTH")


# Metin alanlarının alt sınırını ve bir eksiğini denetler.
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_text_field_min_length(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
) -> None:
    lowest = max(min_length, 1)
    _ok(_with(_output(kind), dotted, "ş" * lowest))
    below = _with(_output(kind), dotted, "ş" * (lowest - 1))
    if lowest > 1:
        assert _issues(below) == _single(dotted, "LENGTH")
    elif required:
        assert _issues(below) == _single(dotted, "REQUIRED")
    else:
        _ok(below)


# Boş, yalnızca boşluk, null ve eksik değerleri zorunlu alanda REQUIRED sayar.
@pytest.mark.parametrize("empty", ["", "   ", " \n\t ", None, MISSING])
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_text_field_empty_values(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
    empty: object,
) -> None:
    output = _with(_output(kind), dotted, empty)
    if required:
        assert _issues(output) == _single(dotted, "REQUIRED")
    else:
        _ok(output)


# Metin olmayan değerleri TYPE olarak reddeder.
@pytest.mark.parametrize("value", [123, 1.5, True, ["a"], {"a": "b"}])
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_text_field_rejects_non_text(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
    value: object,
) -> None:
    output = _with(_output(kind), dotted, value)
    assert _issues(output) == _single(dotted, "TYPE")


# Satır sonu dışındaki kontrol karakterlerini bütün metin alanlarında reddeder.
@pytest.mark.parametrize("code", [0x00, 0x08, 0x09, 0x0B, 0x0C, 0x1B, 0x1F, 0x7F])
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_text_field_rejects_control_characters(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
    code: int,
) -> None:
    output = _with(_output(kind), dotted, "ab" + chr(code) + "cd")
    assert _issues(output) == _single(dotted, "CONTROL_CHAR")


# Satır sonuna yalnızca notes ve instructions alanlarında izin verir.
@pytest.mark.parametrize("line_break", ["\n", "\r", "\r\n"])
@pytest.mark.parametrize(TEXT_PARAMS, TEXT_FIELDS)
def test_line_breaks_only_in_multiline_fields(
    kind: str,
    dotted: str,
    required: bool,
    min_length: int,
    max_length: int,
    multiline: bool,
    line_break: str,
) -> None:
    output = _with(_output(kind), dotted, "ab" + line_break + "cd")
    if multiline:
        _ok(output)
    else:
        assert _issues(output) == _single(dotted, "CONTROL_CHAR")


# Çok satırlı alanlarda satır sonları korunur.
def test_multiline_values_keep_line_breaks() -> None:
    output = _with(_output("prescription"), "proposal.notes", "Birinci\r\nİkinci")
    _with(output, "proposal.prescription.instructions", "Sabah\nAkşam")
    result = _ok(output)
    assert result.proposal.notes == "Birinci\r\nİkinci"
    assert result.proposal.prescription.instructions == "Sabah\nAkşam"


# Baştaki ve sondaki boşlukları medical-record'daki JavaScript trim() kuralıyla kırpar.
def test_text_is_trimmed_like_javascript() -> None:
    output = _output("lab")
    output["proposal"]["title"] = chr(0xFEFF) + " \t Hemogram" + chr(0x3000) + "\n"
    item = output["proposal"]["labResult"]["items"][0]
    item["testName"] = chr(0xA0) + "WBC" + chr(0x2028)
    item["unit"] = chr(0x2009) + "g/dL" + chr(0x202F)
    result = _ok(output)
    assert result.proposal.title == "Hemogram"
    assert result.proposal.lab_result.items[0].test_name == "WBC"
    assert result.proposal.lab_result.items[0].unit == "g/dL"


# JavaScript trim()'in atmadığı kenar kontrol karakterleri reddedilir.
@pytest.mark.parametrize("code", [0x1C, 0x1F])
def test_edge_control_characters_are_not_trimmed(code: int) -> None:
    output = _with(_output("lab"), "proposal.title", chr(code) + "Hemogram")
    assert _issues(output) == _single("proposal.title", "CONTROL_CHAR")


# C1 aralığındaki karakterler medical-record'da olduğu gibi kontrol karakteri sayılmaz.
def test_c1_characters_are_accepted_like_medical_record() -> None:
    title = "Hemo" + chr(0x85) + "gram" + chr(0x9F)
    result = _ok(_with(_output("lab"), "proposal.title", title))
    assert result.proposal.title == title


# Uzunluk Unicode karakter olarak, varyasyon seçicisi medical-record gibi sayılır.
def test_length_is_counted_like_medical_record() -> None:
    emoji = chr(0x1F600)
    selector = chr(0xFE0F)
    _ok(_with(_output("lab"), "proposal.title", emoji * 128))
    too_long = _with(_output("lab"), "proposal.title", emoji * 129)
    assert _issues(too_long) == _single("proposal.title", "LENGTH")
    _ok(_with(_output("lab"), "proposal.title", "ş" * 128 + selector))
    too_short = _with(_output("lab"), "proposal.title", "ş" + selector)
    assert _issues(too_short) == _single("proposal.title", "LENGTH")


# UTF-8'e çevrilemeyen tek başına vekil karakter FORMAT olarak reddedilir.
def test_lone_surrogate_is_format_error() -> None:
    output = _with(_output("lab"), "proposal.title", "Hemo" + chr(0xD800) + "gram")
    assert _issues(output) == _single("proposal.title", "FORMAT")
    assert _issues(json.dumps(output)) == _single("proposal.title", "FORMAT")


# Türün zorunlu ayrıntısı yoksa ya da nesne değilse sorun bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [(MISSING, "REQUIRED"), (None, "REQUIRED"), ([], "TYPE"), ("metin", "TYPE")],
)
@pytest.mark.parametrize(
    ("kind", "key"),
    [
        ("lab", "labResult"),
        ("vaccination", "vaccination"),
        ("prescription", "prescription"),
    ],
)
def test_required_details(kind: str, key: str, value: object, code: str) -> None:
    output = _with(_output(kind), f"proposal.{key}", value)
    assert _issues(output) == _single(f"proposal.{key}", code)


# Ayrıntı eksikken boş recordedAt için ek sorun üretilmez.
def test_missing_details_do_not_add_date_issues() -> None:
    output = _with(_output("lab"), "proposal.labResult", None)
    _with(output, "proposal.recordedAt", "")
    assert _issues(output) == _single("proposal.labResult", "REQUIRED")


# Tahlil kalem sayısını 1–50 sınırlarıyla denetler.
@pytest.mark.parametrize(
    ("count", "code"), [(0, "REQUIRED"), (1, None), (50, None), (51, "COUNT")]
)
def test_lab_item_count_bounds(count: int, code: str | None) -> None:
    output = _output("lab")
    item = output["proposal"]["labResult"]["items"][0]
    output["proposal"]["labResult"]["items"] = [dict(item) for _ in range(count)]
    if code is None:
        assert len(_ok(output).proposal.lab_result.items) == count
    else:
        assert _issues(output) == _single("proposal.labResult.items", code)


# Tahlil kalemleri yoksa REQUIRED, dizi değilse TYPE bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [(MISSING, "REQUIRED"), (None, "REQUIRED"), ("WBC", "TYPE"), ({}, "TYPE")],
)
def test_lab_items_must_be_list(value: object, code: str) -> None:
    output = _with(_output("lab"), "proposal.labResult.items", value)
    assert _issues(output) == _single("proposal.labResult.items", code)


# Nesne olmayan tahlil kalemi kendi sırasıyla TYPE olarak bildirilir.
def test_lab_item_must_be_object() -> None:
    output = _output("lab")
    items = output["proposal"]["labResult"]["items"]
    items.extend(["WBC", dict(items[0])])
    assert _issues(output) == _single("proposal.labResult.items.1", "TYPE")


# Boş ya da eksik flag UNSPECIFIED olur, geçerli adlar proto değerine çevrilir.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (MISSING, medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED),
        (None, medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED),
        ("", medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED),
        ("  ", medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED),
        ("NORMAL", medical_record_pb2.NORMAL),
        ("LOW", medical_record_pb2.LOW),
        ("HIGH", medical_record_pb2.HIGH),
        (" HIGH ", medical_record_pb2.HIGH),
    ],
)
def test_lab_flag_values(value: object, expected: int) -> None:
    output = _with(_output("lab"), "proposal.labResult.items.0.flag", value)
    result = _ok(output)
    assert result.proposal.lab_result.items[0].flag == expected


# Geçersiz flag değerlerini uygun kodla reddeder.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        ("H", "ENUM"),
        ("high", "ENUM"),
        ("LAB_RESULT_FLAG_UNSPECIFIED", "ENUM"),
        ("YUKSEK", "ENUM"),
        (1, "TYPE"),
        (True, "TYPE"),
    ],
)
def test_invalid_lab_flag(value: object, code: str) -> None:
    dotted = "proposal.labResult.items.0.flag"
    assert _issues(_with(_output("lab"), dotted, value)) == _single(dotted, code)


# Tarih alanları bugünü kabul eder, yarını FUTURE_DATE olarak reddeder.
@pytest.mark.parametrize(("kind", "dotted"), DATE_FIELDS)
def test_date_field_future_boundary(kind: str, dotted: str) -> None:
    _ok(_with(_output(kind), dotted, TODAY_TEXT))
    output = _with(_output(kind), dotted, TOMORROW_TEXT)
    assert _issues(output) == _single(dotted, "FUTURE_DATE")


# Geçersiz biçimdeki ya da var olmayan tarihleri FORMAT olarak reddeder.
@pytest.mark.parametrize(
    "value",
    [
        "20.10.2026",
        "2026/10/20",
        "2026-1-05",
        "26-10-20",
        "20261020",
        "2026-10-20T00:00:00",
        "2026-W43-1",
        "2026-02-30",
        "2025-02-29",
        "1900-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-10-00",
        "0999-12-31",
        "0000-01-01",
        "2026-10-2a",
        FULLWIDTH_DATE,
    ],
)
@pytest.mark.parametrize(("kind", "dotted"), DATE_FIELDS)
def test_date_field_rejects_invalid_format(kind: str, dotted: str, value: str) -> None:
    output = _with(_output(kind), dotted, value)
    assert _issues(output) == _single(dotted, "FORMAT")


# Artık yıl günü ve 1000 yılı gibi sınır tarihleri kabul edilir.
@pytest.mark.parametrize("value", ["2024-02-29", "2000-02-29", "1000-01-01"])
@pytest.mark.parametrize(("kind", "dotted"), DATE_FIELDS)
def test_date_field_accepts_valid_edges(kind: str, dotted: str, value: str) -> None:
    _ok(_with(_output(kind), dotted, value))


# Metin olmayan tarihleri TYPE olarak reddeder.
@pytest.mark.parametrize("value", [20261020, 2026.1, True, ["2026-10-20"]])
@pytest.mark.parametrize(("kind", "dotted"), DATE_FIELDS)
def test_date_field_rejects_non_text(kind: str, dotted: str, value: object) -> None:
    output = _with(_output(kind), dotted, value)
    assert _issues(output) == _single(dotted, "TYPE")


# Tarihlerin baştaki ve sondaki boşlukları kırpılır.
def test_dates_are_trimmed() -> None:
    output = _with(_output("lab"), "proposal.recordedAt", " 2026-10-19 ")
    _with(output, "proposal.labResult.sampledAt", "\t2026-10-18\n")
    result = _ok(output)
    assert result.proposal.recorded_at == "2026-10-19"
    assert result.proposal.lab_result.sampled_at == "2026-10-18"


# nextDueAt isteğe bağlıdır ve gelecekte olabilir.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (MISSING, ""),
        (None, ""),
        ("", ""),
        ("2026-10-21", "2026-10-21"),
        ("2030-01-01", "2030-01-01"),
    ],
)
def test_next_due_at_is_optional_and_may_be_future(
    value: object, expected: str
) -> None:
    output = _with(_output("vaccination"), "proposal.vaccination.nextDueAt", value)
    assert _ok(output).proposal.vaccination.next_due_at == expected


# nextDueAt administeredAt'e eşit ya da ondan önceyse ORDER bildirir.
@pytest.mark.parametrize("value", ["2026-10-20", "2026-10-19", "2025-01-01"])
def test_next_due_at_must_follow_administered_at(value: str) -> None:
    dotted = "proposal.vaccination.nextDueAt"
    output = _with(_output("vaccination"), dotted, value)
    assert _issues(output) == _single(dotted, "ORDER")


# nextDueAt geçersiz biçimdeyse FORMAT, metin değilse TYPE bildirir.
@pytest.mark.parametrize(("value", "code"), [("2027-02-30", "FORMAT"), (7, "TYPE")])
def test_invalid_next_due_at(value: object, code: str) -> None:
    dotted = "proposal.vaccination.nextDueAt"
    output = _with(_output("vaccination"), dotted, value)
    assert _issues(output) == _single(dotted, code)


# Sıra denetimi, recordedAt'ten tamamlanan administeredAt ile yapılır.
def test_next_due_at_is_compared_with_completed_administered_at() -> None:
    output = _with(_output("vaccination"), "proposal.vaccination.administeredAt", "")
    _with(output, "proposal.vaccination.nextDueAt", "2026-10-20")
    assert _issues(output) == _single("proposal.vaccination.nextDueAt", "ORDER")


# Gelecekteki administeredAt'e karşı sıra denetimi de aynı anda yapılır.
def test_order_is_checked_even_if_administered_at_is_future() -> None:
    output = _with(
        _output("vaccination"), "proposal.vaccination.administeredAt", "2026-12-01"
    )
    _with(output, "proposal.vaccination.nextDueAt", "2026-11-01")
    assert _issues(output) == (
        ValidationIssue("proposal.vaccination.administeredAt", "FUTURE_DATE"),
        ValidationIssue("proposal.vaccination.nextDueAt", "ORDER"),
    )


# durationDays 1–365 aralığındaki tam sayıları kabul eder.
@pytest.mark.parametrize(("value", "expected"), [(1, 1), (7, 7), (365, 365), (7.0, 7)])
def test_duration_days_accepts_bounds(value: object, expected: int) -> None:
    output = _with(_output("prescription"), "proposal.prescription.durationDays", value)
    assert _ok(output).proposal.prescription.duration_days == expected


# durationDays aralık dışındaysa RANGE, yoksa REQUIRED, tam sayı değilse TYPE bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (0, "RANGE"),
        (366, "RANGE"),
        (-5, "RANGE"),
        (10**20, "RANGE"),
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("7", "TYPE"),
        ("7 gün", "TYPE"),
        (7.5, "TYPE"),
        (True, "TYPE"),
        (math.nan, "TYPE"),
        (math.inf, "TYPE"),
        ([7], "TYPE"),
    ],
)
def test_invalid_duration_days(value: object, code: str) -> None:
    dotted = "proposal.prescription.durationDays"
    output = _with(_output("prescription"), dotted, value)
    assert _issues(output) == _single(dotted, code)


# Belgede hiç tarih yoksa tarihler olayın İstanbul tarihi olur, güven en fazla 0.5 olur.
@pytest.mark.parametrize("empty", ["", None, MISSING, "   "])
@pytest.mark.parametrize(("kind", "detail_dotted"), PAIRED_DATES)
def test_no_dates_are_completed_from_event_time(
    kind: str, detail_dotted: str, empty: object
) -> None:
    output = _with(_output(kind), "proposal.recordedAt", empty)
    _with(output, detail_dotted, empty)
    result = _ok(output)
    details = getattr(result.proposal, result.proposal.WhichOneof("details"))
    detail_field = {
        "lab": "sampled_at",
        "vaccination": "administered_at",
        "prescription": "prescribed_at",
    }[kind]
    assert result.proposal.recorded_at == EVENT_DAY
    assert getattr(details, detail_field) == EVENT_DAY
    assert result.date_estimated is True
    assert result.confidence == pytest.approx(0.5)


# Ayrıntısız türlerde boş recordedAt olayın tarihiyle doldurulur.
@pytest.mark.parametrize("kind", ["examination", "surgery"])
def test_plain_type_without_date_is_completed(kind: str) -> None:
    result = _ok(_with(_output(kind), "proposal.recordedAt", ""))
    assert result.proposal.recorded_at == EVENT_DAY
    assert result.date_estimated is True
    assert result.confidence == pytest.approx(0.5)


# Tahmini tarihte güven 0.5'ten düşükse olduğu gibi kalır, kırpma önce yapılır.
@pytest.mark.parametrize(
    ("confidence", "expected"), [(0.3, 0.3), (1.7, 0.5), (-1, 0.0)]
)
def test_estimated_date_caps_confidence(confidence: float, expected: float) -> None:
    output = _with(_output("lab"), "confidence", confidence)
    _with(output, "proposal.recordedAt", "")
    _with(output, "proposal.labResult.sampledAt", "")
    assert _ok(output).confidence == pytest.approx(expected)


# Olay zamanı İstanbul tarihine çevrilir, saat dilimsiz zaman UTC sayılır.
@pytest.mark.parametrize(
    ("event_time", "expected"),
    [
        (datetime(2026, 10, 21, 20, 59, tzinfo=UTC), "2026-10-21"),
        (datetime(2026, 10, 21, 21, 0, tzinfo=UTC), "2026-10-22"),
        (datetime(2026, 10, 21, 22, 30), "2026-10-22"),
        (
            datetime(2026, 10, 21, 19, 0, tzinfo=timezone(timedelta(hours=-5))),
            "2026-10-22",
        ),
        (
            datetime(2026, 10, 22, 1, 0, tzinfo=timezone(timedelta(hours=9))),
            "2026-10-21",
        ),
    ],
)
def test_event_day_uses_istanbul_date(event_time: datetime, expected: str) -> None:
    output = _with(_output("examination"), "proposal.recordedAt", "")
    assert _ok(output, event_time=event_time).proposal.recorded_at == expected


# Olayın tarihi bugünden ileriyse tamamlanan tarihler de FUTURE_DATE olur.
def test_completed_dates_are_checked_against_today() -> None:
    output = _with(_output("lab"), "proposal.recordedAt", "")
    _with(output, "proposal.labResult.sampledAt", "")
    assert _issues(output, today=date(2026, 10, 20)) == (
        ValidationIssue("proposal.labResult.sampledAt", "FUTURE_DATE"),
        ValidationIssue("proposal.recordedAt", "FUTURE_DATE"),
    )


# Yalnızca recordedAt doluysa türün tarihi ondan kopyalanır, güven değişmez.
@pytest.mark.parametrize(("kind", "detail_dotted"), PAIRED_DATES)
def test_only_recorded_at_is_copied_to_detail_date(
    kind: str, detail_dotted: str
) -> None:
    output = _with(_output(kind), "proposal.recordedAt", "2026-10-15")
    _with(output, detail_dotted, "")
    result = _ok(output)
    details = json_format.MessageToDict(result.proposal)
    detail_key, date_key = detail_dotted.split(".")[1:]
    assert details[detail_key][date_key] == "2026-10-15"
    assert result.proposal.recorded_at == "2026-10-15"
    assert result.date_estimated is False
    assert result.confidence == pytest.approx(_output(kind)["confidence"])


# Yalnızca türün tarihi doluysa recordedAt ondan kopyalanır, güven değişmez.
@pytest.mark.parametrize(("kind", "detail_dotted"), PAIRED_DATES)
def test_only_detail_date_is_copied_to_recorded_at(
    kind: str, detail_dotted: str
) -> None:
    output = _with(_output(kind), "proposal.recordedAt", None)
    _with(output, detail_dotted, "2026-10-14")
    result = _ok(output)
    details = json_format.MessageToDict(result.proposal)
    detail_key, date_key = detail_dotted.split(".")[1:]
    assert result.proposal.recorded_at == "2026-10-14"
    assert details[detail_key][date_key] == "2026-10-14"
    assert result.date_estimated is False
    assert result.confidence == pytest.approx(_output(kind)["confidence"])


# İki tarih de doluysa farklı olsalar bile oldukları gibi kalır.
@pytest.mark.parametrize(("kind", "detail_dotted"), PAIRED_DATES)
def test_both_dates_are_kept(kind: str, detail_dotted: str) -> None:
    output = _with(_output(kind), "proposal.recordedAt", "2026-10-16")
    _with(output, detail_dotted, "2026-10-12")
    result = _ok(output)
    details = json_format.MessageToDict(result.proposal)
    detail_key, date_key = detail_dotted.split(".")[1:]
    assert result.proposal.recorded_at == "2026-10-16"
    assert details[detail_key][date_key] == "2026-10-12"
    assert result.date_estimated is False


# Kopyalanacak tarih geçersizse sorun yalnızca dolu alanda bildirilir.
@pytest.mark.parametrize(
    ("recorded", "sampled", "expected"),
    [
        ("", "2026-13-01", _single("proposal.labResult.sampledAt", "FORMAT")),
        ("", TOMORROW_TEXT, _single("proposal.labResult.sampledAt", "FUTURE_DATE")),
        ("20.10.2026", "", _single("proposal.recordedAt", "FORMAT")),
        (TOMORROW_TEXT, None, _single("proposal.recordedAt", "FUTURE_DATE")),
        ("", 20261020, _single("proposal.labResult.sampledAt", "TYPE")),
    ],
)
def test_invalid_source_date_is_not_copied(
    recorded: object, sampled: object, expected: tuple[ValidationIssue, ...]
) -> None:
    output = _with(_output("lab"), "proposal.recordedAt", recorded)
    _with(output, "proposal.labResult.sampledAt", sampled)
    assert _issues(output) == expected


# Kayıt türü geçersizken boş recordedAt için ek sorun üretilmez.
def test_invalid_type_skips_date_completion() -> None:
    output = _with(_output("lab"), "proposal.type", "BILINMEYEN")
    _with(output, "proposal.recordedAt", "")
    assert _issues(output) == _single("proposal.type", "ENUM")


# today verilmezse Europe/Istanbul'a göre bugünün tarihi kullanılır.
def test_today_defaults_to_current_istanbul_date() -> None:
    now = datetime.now(UTC).date()
    future = _with(
        _output("lab"), "proposal.recordedAt", (now + timedelta(days=2)).isoformat()
    )
    with pytest.raises(ExtractionInvalid) as caught:
        validate_extraction(future, event_time=EVENT_TIME)
    assert caught.value.issues == _single("proposal.recordedAt", "FUTURE_DATE")
    past = _with(
        _output("lab"), "proposal.recordedAt", (now - timedelta(days=2)).isoformat()
    )
    validate_extraction(past, event_time=EVENT_TIME)


# İş saat dilimi Türkiye'nin UTC+3 farkını verir.
def test_business_time_zone_offset() -> None:
    moment = datetime(2026, 7, 1, 12, 0, tzinfo=UTC).astimezone(BUSINESS_TIME_ZONE)
    assert moment.utcoffset() == timedelta(hours=3)


# Diğer türlerin ayrıntıları bozuk olsa bile sessizce atılır.
def test_other_type_details_are_dropped() -> None:
    output = _output("lab")
    output["proposal"]["vaccination"] = {"vaccineName": 5, SECRET_MARKER: True}
    output["proposal"]["prescription"] = "çöp"
    result = _ok(output)
    assert result.proposal.WhichOneof("details") == "lab_result"
    assert not result.proposal.HasField("vaccination")
    assert not result.proposal.HasField("prescription")


# Aşı kaydında tahlil ve reçete ayrıntıları atılır.
def test_vaccination_drops_other_details() -> None:
    output = _output("vaccination")
    output["proposal"]["labResult"] = _output("lab")["proposal"]["labResult"]
    output["proposal"]["prescription"] = _output("prescription")["proposal"][
        "prescription"
    ]
    result = _ok(output)
    assert result.proposal.WhichOneof("details") == "vaccination"


# EXAMINATION ve SURGERY kayıtları ayrıntı taşımaz, gelen ayrıntılar atılır.
@pytest.mark.parametrize("kind", ["examination", "surgery"])
def test_plain_types_drop_all_details(kind: str) -> None:
    output = _output(kind)
    output["proposal"]["labResult"] = _output("lab")["proposal"]["labResult"]
    output["proposal"]["vaccination"] = {"vaccineName": ""}
    output["proposal"]["prescription"] = []
    result = _ok(output)
    assert result.proposal.WhichOneof("details") is None


# Şema dışındaki alanlar her düzeyde sessizce atılır.
def test_unknown_fields_are_dropped() -> None:
    output = _output("lab")
    output["diagnosis"] = SECRET_MARKER
    output["proposal"]["treatment"] = SECRET_MARKER
    output["proposal"]["labResult"]["comment"] = SECRET_MARKER
    output["proposal"]["labResult"]["items"][0]["interpretation"] = SECRET_MARKER
    result = _ok(output)
    assert result == _ok(_output("lab"))
    assert SECRET_MARKER not in str(json_format.MessageToDict(result.proposal))


# Bütün sorunlar tek seferde, alan yolu sırasıyla ve sayısal dizi sırasıyla listelenir.
def test_multiple_issues_are_collected_in_path_order() -> None:
    output = _output("lab")
    output["isMedicalDocument"] = "evet"
    output["confidence"] = "yüksek"
    proposal = output["proposal"]
    proposal["title"] = ""
    proposal["notes"] = "a\tb"
    proposal["recordedAt"] = TOMORROW_TEXT
    proposal["labResult"]["sampledAt"] = "20.10.2026"
    item = proposal["labResult"]["items"][0]
    items = [dict(item) for _ in range(11)]
    items[2]["value"] = ""
    items[10]["flag"] = "H"
    items[10]["unit"] = "x" * 33
    proposal["labResult"]["items"] = items
    assert _issues(output) == (
        ValidationIssue("confidence", "TYPE"),
        ValidationIssue("isMedicalDocument", "TYPE"),
        ValidationIssue("proposal.labResult.items[2].value", "REQUIRED"),
        ValidationIssue("proposal.labResult.items[10].flag", "ENUM"),
        ValidationIssue("proposal.labResult.items[10].unit", "LENGTH"),
        ValidationIssue("proposal.labResult.sampledAt", "FORMAT"),
        ValidationIssue("proposal.notes", "CONTROL_CHAR"),
        ValidationIssue("proposal.recordedAt", "FUTURE_DATE"),
        ValidationIssue("proposal.title", "REQUIRED"),
    )


# Aynı alanda birden çok kural ihlali ayrı kodlarla bildirilir.
def test_one_field_can_have_several_codes() -> None:
    output = _with(_output("lab"), "proposal.title", "ş" * 129 + "\tş")
    assert _issues(output) == (
        ValidationIssue("proposal.title", "CONTROL_CHAR"),
        ValidationIssue("proposal.title", "LENGTH"),
    )


# ExtractionInvalid sorunları tekrarsız ve sıralı saklar, metni içerik içermez.
def test_extraction_invalid_orders_issues_and_hides_content() -> None:
    error = ExtractionInvalid(
        [
            ValidationIssue("proposal.title", "LENGTH"),
            ValidationIssue("$", "FORMAT"),
            ValidationIssue("proposal.title", "LENGTH"),
            ValidationIssue("proposal.labResult.items[10].value", "REQUIRED"),
            ValidationIssue("proposal.labResult.items[9].value", "REQUIRED"),
            ValidationIssue("proposal.title", "CONTROL_CHAR"),
        ]
    )
    assert error.issues == (
        ValidationIssue("$", "FORMAT"),
        ValidationIssue("proposal.labResult.items[9].value", "REQUIRED"),
        ValidationIssue("proposal.labResult.items[10].value", "REQUIRED"),
        ValidationIssue("proposal.title", "CONTROL_CHAR"),
        ValidationIssue("proposal.title", "LENGTH"),
    )
    assert "proposal" not in str(error)
    assert "LENGTH" not in str(error)


# Doğrulama hatasının metni ve repr'i model çıktısındaki değerleri içermez.
def test_extraction_invalid_text_has_no_output_values() -> None:
    output = _with(_output("lab"), "proposal.title", SECRET_MARKER * 20)
    _with(output, "proposal.labResult.items.0.value", SECRET_MARKER + "\t")
    with pytest.raises(ExtractionInvalid) as caught:
        _ok(output)
    assert SECRET_MARKER not in str(caught.value)
    assert SECRET_MARKER not in repr(caught.value)
    assert all(SECRET_MARKER not in repr(issue) for issue in caught.value.issues)


# ValidationIssue ve ExtractionResult değiştirilemez.
def test_dataclasses_are_frozen() -> None:
    issue = ValidationIssue("proposal.title", "LENGTH")
    with pytest.raises(FrozenInstanceError):
        issue.code = "TYPE"
    result = _ok(_output("lab"))
    with pytest.raises(FrozenInstanceError):
        result.confidence = 0.1
