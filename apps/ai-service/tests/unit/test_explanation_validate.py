import copy
import json
import math
from dataclasses import FrozenInstanceError
from typing import Any

import pytest
from google.protobuf import json_format

from app.explanations.validate import (
    EXPLANATION_MAX_LENGTH,
    ISSUE_CODES,
    ITEMS_MAX,
    SUMMARY_MAX_LENGTH,
    ExplanationInvalid,
    ExplanationResult,
    validate_explanation,
)
from app.generated import medical_record_pb2
from app.validation import OutputInvalid, ValidationIssue

SECRET_MARKER = "GIZLI-ACIKLAMA-7Q"
MISSING = object()
ALT_EXPLANATION = (
    "ALT, karaciğer hücrelerinde bulunan bir enzimdir. Hafif yükseklik farklı "
    "nedenlerle görülebilir; ne anlama geldiğini veteriner hekiminiz muayene "
    "bulgularıyla birlikte değerlendirir."
)
CONTRACT_SUMMARY = (
    "Tahlildeki değerlerin çoğu referans aralığında. Karaciğerle ilgili ALT "
    "değeri aralığın biraz üzerinde."
)
CONTRACT_EXAMPLE_TEXT = json.dumps(
    {
        "confidence": 0.82,
        "summary": CONTRACT_SUMMARY,
        "items": [{"testName": "ALT", "explanation": ALT_EXPLANATION}],
    },
    ensure_ascii=False,
    indent=2,
)
REQUEST_ITEMS = (
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
)
TEXT_FIELDS = [
    pytest.param("summary", "summary", SUMMARY_MAX_LENGTH, id="summary"),
    pytest.param(
        "items.0.explanation",
        "items[0].explanation",
        EXPLANATION_MAX_LENGTH,
        id="explanation",
    ),
]


# Sözleşme 7.4'teki örneğin bağımsız bir kopyasını sözlük olarak döndürür.
def _output() -> dict[str, Any]:
    return copy.deepcopy(json.loads(CONTRACT_EXAMPLE_TEXT))


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


# Verilen test adlarıyla, diğer alanları dolu istek kalemleri üretir.
def _request(*names: str) -> tuple[medical_record_pb2.LabResultItem, ...]:
    return tuple(
        medical_record_pb2.LabResultItem(test_name=name, value="1") for name in names
    )


# Çıktıyı istek kalemleriyle doğrulayıp sonucu döndürür.
def _ok(
    output: object,
    request: tuple[medical_record_pb2.LabResultItem, ...] = REQUEST_ITEMS,
) -> ExplanationResult:
    return validate_explanation(output, request)


# Çıktının reddedildiğini doğrular ve bulunan sorunları döndürür.
def _issues(
    output: object,
    request: tuple[medical_record_pb2.LabResultItem, ...] = REQUEST_ITEMS,
) -> tuple[ValidationIssue, ...]:
    with pytest.raises(ExplanationInvalid) as caught:
        validate_explanation(output, request)
    return caught.value.issues


# Tek bir sorun beklenen durumlar için karşılaştırma değerini kurar.
def _single(path: str, code: str) -> tuple[ValidationIssue, ...]:
    return (ValidationIssue(path, code),)


# Sözleşme 7.4'teki örnek ham metin olarak verilince geçerli bir LabExplanation olur.
def test_contract_example_becomes_lab_explanation() -> None:
    result = _ok(CONTRACT_EXAMPLE_TEXT)

    assert isinstance(result.explanation, medical_record_pb2.LabExplanation)
    assert result.confidence == pytest.approx(0.82)
    assert json_format.MessageToDict(result.explanation) == {
        "summary": CONTRACT_SUMMARY,
        "items": [{"testName": "ALT", "explanation": ALT_EXPLANATION}],
    }


# items boş liste olabilir; açıklanacak değer yoksa yalnızca özet döner.
def test_empty_items_are_accepted() -> None:
    result = _ok(_with(_output(), "items", []))

    assert list(result.explanation.items) == []
    assert result.explanation.summary == CONTRACT_SUMMARY


# İstek kalemleri protobuf'un tekrarlı alanı ya da üreteç olarak da verilebilir.
def test_request_items_can_be_any_iterable() -> None:
    request = medical_record_pb2.LabResultDetails(items=REQUEST_ITEMS).items

    assert _ok(_output(), request).explanation.items[0].test_name == "ALT"
    generator = (item for item in REQUEST_ITEMS)
    assert validate_explanation(_output(), generator).confidence == pytest.approx(0.82)


# JSON olmayan ya da nesne olmayan ham metinleri kök FORMAT sorunuyla reddeder.
@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "merhaba",
        "{",
        pytest.param("```json\n" + CONTRACT_EXAMPLE_TEXT + "\n```", id="markdown"),
        "[1, 2]",
        "null",
        "42",
        '"metin"',
        pytest.param(CONTRACT_EXAMPLE_TEXT.replace("0.82", "NaN"), id="nan"),
        pytest.param(CONTRACT_EXAMPLE_TEXT.replace("0.82", "Infinity"), id="inf"),
        pytest.param(
            CONTRACT_EXAMPLE_TEXT.replace("0.82", "-Infinity"), id="negative-inf"
        ),
        pytest.param("[" * 100000, id="deep-nesting"),
    ],
)
def test_non_json_text_is_format_error(text: str) -> None:
    assert _issues(text) == _single("$", "FORMAT")


# Metin ya da sözlük olmayan girdileri kök FORMAT sorunuyla reddeder.
@pytest.mark.parametrize("value", [None, 42, 0.5, True, [1], b"{}", bytearray(b"{}")])
def test_non_object_input_is_format_error(value: object) -> None:
    assert _issues(value) == _single("$", "FORMAT")


# confidence değerini [0, 1] aralığına kırpar ve float döndürür.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.82, 0.82),
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
    result = _ok(_with(_output(), "confidence", value))

    assert result.confidence == pytest.approx(expected)
    assert isinstance(result.confidence, float)


# Negatif sıfır confidence pozitif sıfıra çevrilir.
def test_negative_zero_confidence_becomes_zero() -> None:
    result = _ok(_with(_output(), "confidence", -0.0))

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
    assert _issues(_with(_output(), "confidence", value)) == _single(
        "confidence", "TYPE"
    )


# JSON'da taşan sayı sonsuza dönüştüğü için TYPE olarak reddedilir.
def test_overflowing_confidence_text_is_type_error() -> None:
    text = CONTRACT_EXAMPLE_TEXT.replace("0.82", "1e400")

    assert _issues(text) == _single("confidence", "TYPE")


# Metin alanlarının üst sınırı kabul edilir, bir fazlası LENGTH olur.
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_max_length(dotted: str, path: str, max_length: int) -> None:
    _ok(_with(_output(), dotted, "ş" * max_length))

    assert _issues(_with(_output(), dotted, "ş" * (max_length + 1))) == _single(
        path, "LENGTH"
    )


# Tek karakterlik metin kabul edilir.
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_min_length(dotted: str, path: str, max_length: int) -> None:
    result = _ok(_with(_output(), dotted, "ş"))

    texts = [result.explanation.summary, result.explanation.items[0].explanation]
    assert "ş" in texts


# Boş, yalnızca boşluk, null ve eksik metinleri REQUIRED sayar.
@pytest.mark.parametrize("empty", ["", "   ", " \n\t ", chr(0xFEFF), None, MISSING])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_empty_values(
    dotted: str, path: str, max_length: int, empty: object
) -> None:
    assert _issues(_with(_output(), dotted, empty)) == _single(path, "REQUIRED")


# Metin olmayan değerleri TYPE olarak reddeder.
@pytest.mark.parametrize("value", [123, 1.5, True, ["a"], {"a": "b"}])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_rejects_non_text(
    dotted: str, path: str, max_length: int, value: object
) -> None:
    assert _issues(_with(_output(), dotted, value)) == _single(path, "TYPE")


# Satır sonu dışındaki kontrol karakterlerini summary ve explanation'da reddeder.
@pytest.mark.parametrize("code", [0x00, 0x08, 0x09, 0x0B, 0x0C, 0x1B, 0x1F, 0x7F])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_rejects_control_characters(
    dotted: str, path: str, max_length: int, code: int
) -> None:
    output = _with(_output(), dotted, "ab" + chr(code) + "cd")

    assert _issues(output) == _single(path, "CONTROL_CHAR")


# summary ve explanation'da satır sonları serbesttir ve korunur.
@pytest.mark.parametrize("line_break", ["\n", "\r", "\r\n"])
def test_line_breaks_are_kept_in_text_fields(line_break: str) -> None:
    output = _with(_output(), "summary", "Birinci" + line_break + "İkinci")
    _with(output, "items.0.explanation", "Sabah" + line_break + "Akşam")

    result = _ok(output)

    assert result.explanation.summary == "Birinci" + line_break + "İkinci"
    assert result.explanation.items[0].explanation == "Sabah" + line_break + "Akşam"


# Metinler medical-record'daki JavaScript trim() kuralıyla kırpılmış döner.
def test_texts_are_trimmed_like_javascript() -> None:
    output = _with(_output(), "summary", chr(0xFEFF) + " \t Özet" + chr(0x3000) + "\n")
    _with(output, "items.0.testName", chr(0xA0) + "ALT" + chr(0x2028))
    _with(output, "items.0.explanation", chr(0x2009) + "Açıklama" + chr(0x202F))

    result = _ok(output)

    assert result.explanation.summary == "Özet"
    assert result.explanation.items[0].test_name == "ALT"
    assert result.explanation.items[0].explanation == "Açıklama"


# Kırpma sonrası uzunluk ölçülür; kenardaki boşluklar sınırı aşırmaz.
def test_length_is_measured_after_trim() -> None:
    padded = "  " + "ş" * SUMMARY_MAX_LENGTH + "\n"

    assert len(_ok(_with(_output(), "summary", padded)).explanation.summary) == 2000


# Uzunluk Unicode karakter olarak, varyasyon seçicisi medical-record gibi sayılır.
def test_length_is_counted_like_medical_record() -> None:
    emoji = chr(0x1F600)
    selector = chr(0xFE0F)
    _ok(_with(_output(), "items.0.explanation", emoji * EXPLANATION_MAX_LENGTH))
    _ok(_with(_output(), "summary", "ş" * SUMMARY_MAX_LENGTH + selector))
    too_long = _with(_output(), "items.0.explanation", emoji * 501)

    assert _issues(too_long) == _single("items[0].explanation", "LENGTH")


# Tek başına vekil karakter FORMAT olarak reddedilir.
@pytest.mark.parametrize(
    ("dotted", "path"),
    [
        ("summary", "summary"),
        ("items.0.explanation", "items[0].explanation"),
        ("items.0.testName", "items[0].testName"),
    ],
)
def test_lone_surrogate_is_format_error(dotted: str, path: str) -> None:
    output = _with(_output(), dotted, "AL" + chr(0xD800) + "T")

    assert _issues(output) == _single(path, "FORMAT")
    assert _issues(json.dumps(output)) == _single(path, "FORMAT")


# items yoksa ya da dizi değilse uygun sorunu bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("ALT", "TYPE"),
        ({"testName": "ALT"}, "TYPE"),
        (5, "TYPE"),
    ],
)
def test_items_must_be_array(value: object, code: str) -> None:
    assert _issues(_with(_output(), "items", value)) == _single("items", code)


# 50 kalem kabul edilir, 51 kalem COUNT olur.
def test_items_count_limit() -> None:
    names = [f"T{index}" for index in range(ITEMS_MAX + 1)]
    request = _request(*names)
    items = [{"testName": name, "explanation": "Açıklama"} for name in names]

    assert (
        len(
            _ok(_with(_output(), "items", items[:ITEMS_MAX]), request).explanation.items
        )
        == 50
    )
    assert _issues(_with(_output(), "items", items), request) == _single(
        "items", "COUNT"
    )


# Nesne olmayan kalem TYPE olarak reddedilir, diğer kalemler yine denetlenir.
@pytest.mark.parametrize("item", [None, "ALT", 5, [], True])
def test_item_must_be_object(item: object) -> None:
    items = [item, {"testName": "Kreatinin", "explanation": ""}]

    assert _issues(_with(_output(), "items", items)) == (
        ValidationIssue("items[0]", "TYPE"),
        ValidationIssue("items[1].explanation", "REQUIRED"),
    )


# testName boş, eksik ya da metin değilse uygun sorunu bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("", "REQUIRED"),
        ("  ", "REQUIRED"),
        (5, "TYPE"),
        (["ALT"], "TYPE"),
    ],
)
def test_invalid_test_name(value: object, code: str) -> None:
    output = _with(_output(), "items.0.testName", value)

    assert _issues(output) == _single("items[0].testName", code)


# testName istekteki adlardan biriyle büyük/küçük harf dahil birebir aynı olmalıdır.
@pytest.mark.parametrize(
    "value", ["alt", "Alt", "ALT2", "AL T", "Glukoz", "ALT.", SECRET_MARKER]
)
def test_unknown_test_name_is_enum_error(value: str) -> None:
    output = _with(_output(), "items.0.testName", value)

    assert _issues(output) == _single("items[0].testName", "ENUM")


# testName'de satır sonu dahil hiçbir kontrol karakterine izin verilmez.
@pytest.mark.parametrize("code", [0x00, 0x09, 0x0A, 0x0D, 0x1F, 0x7F])
def test_test_name_rejects_any_control_character(code: int) -> None:
    output = _with(_output(), "items.0.testName", "AL" + chr(code) + "T")

    assert _issues(output) == _single("items[0].testName", "CONTROL_CHAR")


# Kenarlardaki boşluklar kırpıldıktan sonra eşleşen testName kabul edilir.
def test_test_name_matches_after_trim() -> None:
    output = _with(_output(), "items.0.testName", " ALT\n")

    assert _ok(output).explanation.items[0].test_name == "ALT"


# İstekteki test adları da kırpılmış halleriyle karşılaştırılır.
def test_request_test_names_are_trimmed() -> None:
    request = _request(" ALT ", "Kreatinin")

    assert _ok(_output(), request).explanation.items[0].test_name == "ALT"


# Aynı test kırpılmış adıyla ikinci kez geçerse DUPLICATE olur.
@pytest.mark.parametrize(("first", "second"), [("ALT", "ALT"), (" ALT", "ALT ")])
def test_duplicate_test_name(first: str, second: str) -> None:
    items = [
        {"testName": first, "explanation": "Birinci"},
        {"testName": "Kreatinin", "explanation": "İkinci"},
        {"testName": second, "explanation": "Üçüncü"},
    ]

    assert _issues(_with(_output(), "items", items)) == _single(
        "items[2].testName", "DUPLICATE"
    )


# Farklı istek kalemleri sırayla ve tekrarsız açıklanabilir.
def test_each_request_item_can_be_explained_once() -> None:
    items = [
        {"testName": "Kreatinin", "explanation": "İkinci"},
        {"testName": "ALT", "explanation": "Birinci"},
    ]

    result = _ok(_with(_output(), "items", items))

    assert [item.test_name for item in result.explanation.items] == [
        "Kreatinin",
        "ALT",
    ]


# Şema dışındaki alanlar atılır, sonuçta yalnızca proto alanları kalır.
def test_unknown_fields_are_dropped() -> None:
    output = _output()
    output["diagnosis"] = SECRET_MARKER
    output["items"][0]["severity"] = SECRET_MARKER

    result = _ok(output)

    assert SECRET_MARKER not in str(result)
    assert json_format.MessageToDict(result.explanation)["items"] == [
        {"testName": "ALT", "explanation": ALT_EXPLANATION}
    ]


# Birden çok kural ihlali alan yolu ve sayısal dizi sırasıyla bildirilir.
def test_issues_are_reported_in_path_order() -> None:
    names = [f"T{index}" for index in range(11)]
    items = [{"testName": name, "explanation": "Açıklama"} for name in names]
    items[2]["testName"] = "Yok"
    items[10]["explanation"] = "x" * 501
    items[9]["testName"] = "T0"
    output = {"confidence": "yüksek", "summary": "", "items": items}

    assert _issues(output, _request(*names)) == (
        ValidationIssue("confidence", "TYPE"),
        ValidationIssue("items[2].testName", "ENUM"),
        ValidationIssue("items[9].testName", "DUPLICATE"),
        ValidationIssue("items[10].explanation", "LENGTH"),
        ValidationIssue("summary", "REQUIRED"),
    )


# Aynı alanda birden çok kural ihlali ayrı kodlarla bildirilir.
def test_one_field_can_have_several_codes() -> None:
    output = _with(_output(), "summary", "ş" * 2001 + "\tş")

    assert _issues(output) == (
        ValidationIssue("summary", "CONTROL_CHAR"),
        ValidationIssue("summary", "LENGTH"),
    )


# Doğrulama hatası ortak tabandan gelir; metni ve repr'i çıktı değerlerini içermez.
def test_explanation_invalid_hides_output_values() -> None:
    output = _with(_output(), "summary", SECRET_MARKER * 200)
    _with(output, "items.0.testName", SECRET_MARKER)

    with pytest.raises(ExplanationInvalid) as caught:
        _ok(output)

    assert isinstance(caught.value, OutputInvalid)
    assert str(caught.value) == "Model çıktısı doğrulanamadı (2 sorun)"
    assert SECRET_MARKER not in repr(caught.value)
    assert all(SECRET_MARKER not in repr(issue) for issue in caught.value.issues)


# Sorun kodları Akış A'nın kodları ve DUPLICATE'tir.
def test_issue_codes() -> None:
    assert ISSUE_CODES == (
        "REQUIRED",
        "TYPE",
        "FORMAT",
        "ENUM",
        "LENGTH",
        "COUNT",
        "CONTROL_CHAR",
        "DUPLICATE",
    )


# Sınır sabitleri sözleşme 7.4'teki değerlerdir.
def test_limits_match_contract() -> None:
    assert (SUMMARY_MAX_LENGTH, EXPLANATION_MAX_LENGTH, ITEMS_MAX) == (2000, 500, 50)


# ExplanationResult değiştirilemez.
def test_result_is_frozen() -> None:
    result = _ok(_output())

    with pytest.raises(FrozenInstanceError):
        result.confidence = 0.1
