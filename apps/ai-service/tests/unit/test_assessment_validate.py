import copy
import json
import math
from dataclasses import FrozenInstanceError
from typing import Any

import pytest

from app.assessments.validate import (
    CATEGORIES,
    CONDITIONS_MAX,
    EVIDENCE_MAX,
    FINDINGS_MAX,
    ISSUE_CODES,
    LIKELIHOODS,
    NAME_MAX_LENGTH,
    QUESTION_MAX_LENGTH,
    QUESTIONS_MAX,
    RECOMMENDATIONS_MAX,
    RISK_LEVELS,
    SUMMARY_MAX_LENGTH,
    TEXT_MAX_LENGTH,
    AssessmentCondition,
    AssessmentFinding,
    AssessmentInvalid,
    AssessmentRecommendation,
    AssessmentResult,
    has_dose_expression,
    validate_assessment,
)
from app.validation import OutputInvalid, ValidationIssue

SECRET_MARKER = "GIZLI-DEGERLENDIRME-4K"
MISSING = object()
TEST_NAMES = ("HCT", "HGB")
SUMMARY = "Kayıtlar birlikte değerlendirildi; HCT aralığın altında."
EXAMPLE: dict[str, Any] = {
    "confidence": 0.71,
    "riskLevel": "MODERATE",
    "summary": SUMMARY,
    "findings": [
        {"testName": "HCT", "interpretation": "HCT üç ölçümdür azalıyor."},
        {"testName": "HGB", "interpretation": "HGB aralığın içinde."},
    ],
    "possibleConditions": [
        {
            "name": "Kansızlıkla ilişkili bir durum",
            "likelihood": "MEDIUM",
            "evidence": ["HCT", "HGB"],
            "explanation": "Düşen HCT kansızlıkla ilişkili olabilir.",
        },
        {
            "name": "Sıvı dengesiyle ilgili bir durum",
            "likelihood": "LOW",
            "evidence": ["HCT"],
            "explanation": "Sıvı dengesi de değerleri etkileyebilir.",
        },
    ],
    "recommendations": [
        {"category": "VET_VISIT", "text": "Veteriner hekiminize danışın."},
        {"category": "FOLLOW_UP_TEST", "text": "Kontrol hemogramı konuşulabilir."},
    ],
    "questionsForVet": [
        "Kontrol testi ne zaman yapılmalı?",
        "Beslenmede değişiklik gerekir mi?",
        "Parazit kontrolü gerekir mi?",
    ],
}
TEXT_FIELDS = [
    pytest.param("summary", "summary", SUMMARY_MAX_LENGTH, id="summary"),
    pytest.param(
        "findings.0.interpretation",
        "findings[0].interpretation",
        TEXT_MAX_LENGTH,
        id="interpretation",
    ),
    pytest.param(
        "possibleConditions.1.name",
        "possibleConditions[1].name",
        NAME_MAX_LENGTH,
        id="name",
    ),
    pytest.param(
        "possibleConditions.0.explanation",
        "possibleConditions[0].explanation",
        TEXT_MAX_LENGTH,
        id="explanation",
    ),
    pytest.param(
        "recommendations.1.text",
        "recommendations[1].text",
        TEXT_MAX_LENGTH,
        id="recommendation-text",
    ),
    pytest.param(
        "questionsForVet.2", "questionsForVet[2]", QUESTION_MAX_LENGTH, id="question"
    ),
]
MULTILINE_FIELDS = [field for field in TEXT_FIELDS if field.id != "name"]
KEYED_TEXT_FIELDS = [field for field in TEXT_FIELDS if field.id != "question"]
ARRAYS = [
    pytest.param("findings", FINDINGS_MAX, id="findings"),
    pytest.param("possibleConditions", CONDITIONS_MAX, id="possibleConditions"),
    pytest.param("recommendations", RECOMMENDATIONS_MAX, id="recommendations"),
    pytest.param("questionsForVet", QUESTIONS_MAX, id="questionsForVet"),
]
OBJECT_ARRAYS = [field for field in ARRAYS if field.id != "questionsForVet"]
DOSE_TEXTS = [
    "50 mg",
    "2,5 ml",
    "2.5 ml",
    "1 tablet",
    "5mg/kg",
    "10 IU",
    "2 kapsül",
    "3 damla",
    "100 mcg",
    "100 µg",
    "100 μg",
    "4 ünite",
    "Günde 1 Tablet verin",
    "10 MG",
    "1,5g",
    "doz mg / kg ile hesaplanır",
    "0,5 ml/kg",
]
SAFE_TEXTS = [
    "2 gün",
    "günde 2 öğün",
    "3 hafta",
    "%20",
    "T4",
    "100 gram",
    "HCT %33",
    "37-55 aralığı",
    "2 kez",
    "mg ve ml birimleri",
    "10 gün sonra kontrol",
    "B12 vitamini",
    "3 glukoz ölçümü",
]


# Örnek değerlendirme çıktısının bağımsız bir kopyasını döndürür.
def _output() -> dict[str, Any]:
    return copy.deepcopy(EXAMPLE)


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


# Çıktıyı istek adları ve kritik bulgu bilgisiyle doğrulayıp sonucu döndürür.
def _ok(
    output: object,
    names: tuple[str, ...] = TEST_NAMES,
    *,
    has_critical: bool = False,
) -> AssessmentResult:
    return validate_assessment(output, names, has_critical=has_critical)


# Çıktının reddedildiğini doğrular ve bulunan sorunları döndürür.
def _issues(
    output: object,
    names: tuple[str, ...] = TEST_NAMES,
    *,
    has_critical: bool = False,
) -> tuple[ValidationIssue, ...]:
    with pytest.raises(AssessmentInvalid) as caught:
        validate_assessment(output, names, has_critical=has_critical)
    return caught.value.issues


# Tek bir sorun beklenen durumlar için karşılaştırma değerini kurar.
def _single(path: str, code: str) -> tuple[ValidationIssue, ...]:
    return (ValidationIssue(path, code),)


# Geçerli örnek çıktı bütün alanlarıyla değerlendirme sonucuna çevrilir.
def test_example_becomes_result() -> None:
    result = _ok(json.dumps(EXAMPLE, ensure_ascii=False))

    assert result == AssessmentResult(
        confidence=pytest.approx(0.71),
        risk_level="MODERATE",
        summary=SUMMARY,
        findings=(
            AssessmentFinding("HCT", "HCT üç ölçümdür azalıyor."),
            AssessmentFinding("HGB", "HGB aralığın içinde."),
        ),
        possible_conditions=(
            AssessmentCondition(
                "Kansızlıkla ilişkili bir durum",
                "MEDIUM",
                ("HCT", "HGB"),
                "Düşen HCT kansızlıkla ilişkili olabilir.",
            ),
            AssessmentCondition(
                "Sıvı dengesiyle ilgili bir durum",
                "LOW",
                ("HCT",),
                "Sıvı dengesi de değerleri etkileyebilir.",
            ),
        ),
        recommendations=(
            AssessmentRecommendation("VET_VISIT", "Veteriner hekiminize danışın."),
            AssessmentRecommendation(
                "FOLLOW_UP_TEST", "Kontrol hemogramı konuşulabilir."
            ),
        ),
        questions=(
            "Kontrol testi ne zaman yapılmalı?",
            "Beslenmede değişiklik gerekir mi?",
            "Parazit kontrolü gerekir mi?",
        ),
    )


# Bütün listeler boş olabilir; yalnızca özet ve risk düzeyi döner.
def test_empty_lists_are_accepted() -> None:
    output = _output()
    for name in ("findings", "possibleConditions", "recommendations"):
        output[name] = []
    output["questionsForVet"] = []

    result = _ok(output, ())

    assert result.findings == ()
    assert result.possible_conditions == ()
    assert result.recommendations == ()
    assert result.questions == ()
    assert result.summary == SUMMARY


# İstekteki test adları üreteç olarak verilebilir ve kırpılarak karşılaştırılır.
def test_request_names_are_trimmed_iterable() -> None:
    names = (name for name in (" HCT\n", chr(0xA0) + "HGB"))

    result = validate_assessment(_output(), names, has_critical=False)

    assert [finding.test_name for finding in result.findings] == ["HCT", "HGB"]


# JSON olmayan ya da nesne olmayan girdileri kök FORMAT sorunuyla reddeder.
@pytest.mark.parametrize(
    "value",
    [
        "",
        "merhaba",
        "{",
        "[1, 2]",
        "null",
        pytest.param(json.dumps(EXAMPLE).replace("0.71", "NaN"), id="nan"),
        pytest.param("[" * 100000, id="deep-nesting"),
        None,
        42,
        [EXAMPLE],
        b"{}",
    ],
)
def test_non_object_output_is_format_error(value: object) -> None:
    assert _issues(value) == _single("$", "FORMAT")


# confidence [0, 1] aralığına kırpılır; sayı olmayan değer TYPE olur.
@pytest.mark.parametrize(
    ("value", "expected"), [(0.71, 0.71), (1.7, 1.0), (-0.3, 0.0), (1, 1.0)]
)
def test_confidence_is_clipped(value: float, expected: float) -> None:
    assert _ok(_with(_output(), "confidence", value)).confidence == pytest.approx(
        expected
    )


# Sayı olmayan, bool ve sonsuz confidence değerlerini TYPE olarak reddeder.
@pytest.mark.parametrize("value", [MISSING, None, True, "0.7", math.inf])
def test_invalid_confidence_is_type_error(value: object) -> None:
    assert _issues(_with(_output(), "confidence", value)) == _single(
        "confidence", "TYPE"
    )


# riskLevel'ın dört seçeneği kabul edilir ve kırpılarak okunur.
@pytest.mark.parametrize("value", ["LOW", "MODERATE", "HIGH", " URGENT\n"])
def test_risk_level_values(value: str) -> None:
    assert _ok(_with(_output(), "riskLevel", value)).risk_level == value.strip()


# riskLevel eksik, boş, metin dışı ya da seçenek dışıysa uygun sorunu bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("", "REQUIRED"),
        ("  ", "REQUIRED"),
        (3, "TYPE"),
        (["HIGH"], "TYPE"),
        ("high", "ENUM"),
        ("CRITICAL", "ENUM"),
        ("UNSPECIFIED", "ENUM"),
        (SECRET_MARKER, "ENUM"),
    ],
)
def test_invalid_risk_level(value: object, code: str) -> None:
    assert _issues(_with(_output(), "riskLevel", value)) == _single("riskLevel", code)


# Kritik bulgu varsa LOW ve MODERATE riskLevel RISK_FLOOR olur.
@pytest.mark.parametrize("value", ["LOW", "MODERATE", " LOW "])
def test_critical_finding_needs_high_risk(value: str) -> None:
    output = _with(_output(), "riskLevel", value)

    assert _issues(output, has_critical=True) == _single("riskLevel", "RISK_FLOOR")
    assert _ok(output, has_critical=False).risk_level == value.strip()


# Kritik bulgu varken HIGH ve URGENT kabul edilir.
@pytest.mark.parametrize("value", ["HIGH", "URGENT"])
def test_critical_finding_accepts_high_risk(value: str) -> None:
    result = _ok(_with(_output(), "riskLevel", value), has_critical=True)

    assert result.risk_level == value


# Kritik bulguda geçersiz riskLevel yalnızca kendi sorunuyla bildirilir.
@pytest.mark.parametrize(
    ("value", "code"), [(MISSING, "REQUIRED"), (1, "TYPE"), ("low", "ENUM")]
)
def test_invalid_risk_level_has_no_floor_issue(value: object, code: str) -> None:
    output = _with(_output(), "riskLevel", value)

    assert _issues(output, has_critical=True) == _single("riskLevel", code)


# Metin alanlarının üst sınırı kabul edilir, bir fazlası LENGTH olur.
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_max_length(dotted: str, path: str, max_length: int) -> None:
    _ok(_with(_output(), dotted, "ş" * max_length))

    assert _issues(_with(_output(), dotted, "ş" * (max_length + 1))) == _single(
        path, "LENGTH"
    )


# Kırpma sonrası uzunluk ölçülür ve değer kırpılmış döner.
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_is_trimmed(dotted: str, path: str, max_length: int) -> None:
    result = _ok(_with(_output(), dotted, " \t" + "ş" * max_length + "\n"))

    texts = [
        result.summary,
        result.findings[0].interpretation,
        result.possible_conditions[1].name,
        result.possible_conditions[0].explanation,
        result.recommendations[1].text,
        result.questions[2],
    ]
    assert "ş" * max_length in texts


# Boş ya da yalnızca boşluktan oluşan metinler REQUIRED olur.
@pytest.mark.parametrize("empty", ["", "   ", " \n\t ", chr(0xFEFF)])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_blank_values(
    dotted: str, path: str, max_length: int, empty: str
) -> None:
    assert _issues(_with(_output(), dotted, empty)) == _single(path, "REQUIRED")


# Anahtarlı metin alanı eksik ya da null ise REQUIRED olur.
@pytest.mark.parametrize("empty", [None, MISSING])
@pytest.mark.parametrize(("dotted", "path", "max_length"), KEYED_TEXT_FIELDS)
def test_keyed_text_field_missing(
    dotted: str, path: str, max_length: int, empty: object
) -> None:
    assert _issues(_with(_output(), dotted, empty)) == _single(path, "REQUIRED")


# Metin olmayan değerler TYPE olarak reddedilir; soru listesindeki null da TYPE'tır.
@pytest.mark.parametrize("value", [123, 1.5, True, ["a"], {"a": "b"}, None])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_rejects_non_text(
    dotted: str, path: str, max_length: int, value: object
) -> None:
    expected = "REQUIRED" if value is None and dotted != "questionsForVet.2" else "TYPE"

    assert _issues(_with(_output(), dotted, value)) == _single(path, expected)


# Satır sonu dışındaki kontrol karakterleri bütün metin alanlarında reddedilir.
@pytest.mark.parametrize("code", [0x00, 0x08, 0x09, 0x0B, 0x1B, 0x7F])
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_text_field_rejects_control_characters(
    dotted: str, path: str, max_length: int, code: int
) -> None:
    output = _with(_output(), dotted, "ab" + chr(code) + "cd")

    assert _issues(output) == _single(path, "CONTROL_CHAR")


# Çok satırlı metin alanlarında satır sonları serbesttir ve korunur.
@pytest.mark.parametrize("line_break", ["\n", "\r", "\r\n"])
@pytest.mark.parametrize(("dotted", "path", "max_length"), MULTILINE_FIELDS)
def test_line_breaks_are_kept(
    dotted: str, path: str, max_length: int, line_break: str
) -> None:
    text = "Birinci" + line_break + "İkinci"

    result = _ok(_with(_output(), dotted, text))

    assert text in (
        result.summary,
        result.findings[0].interpretation,
        result.possible_conditions[0].explanation,
        result.recommendations[1].text,
        result.questions[2],
    )


# Olası durum adı, testName ve evidence satır sonu içeremez.
@pytest.mark.parametrize(
    ("dotted", "path"),
    [
        ("possibleConditions.0.name", "possibleConditions[0].name"),
        ("findings.0.testName", "findings[0].testName"),
        ("possibleConditions.0.evidence.0", "possibleConditions[0].evidence[0]"),
    ],
)
@pytest.mark.parametrize("line_break", ["\n", "\r"])
def test_single_line_fields_reject_line_breaks(
    dotted: str, path: str, line_break: str
) -> None:
    output = _with(_output(), dotted, "HC" + line_break + "T")

    assert _issues(output) == _single(path, "CONTROL_CHAR")


# Tek başına vekil karakter FORMAT olarak reddedilir.
@pytest.mark.parametrize(
    ("dotted", "path"),
    [
        *((field.values[0], field.values[1]) for field in TEXT_FIELDS),
        ("findings.0.testName", "findings[0].testName"),
        ("possibleConditions.0.evidence.1", "possibleConditions[0].evidence[1]"),
    ],
)
def test_lone_surrogate_is_format_error(dotted: str, path: str) -> None:
    output = _with(_output(), dotted, "HC" + chr(0xD800) + "T")

    assert _issues(output) == _single(path, "FORMAT")


# Sayıyla birlikte doz ya da miktar yazan metinler FORBIDDEN_CONTENT olur.
@pytest.mark.parametrize("dose", DOSE_TEXTS)
@pytest.mark.parametrize(("dotted", "path", "max_length"), TEXT_FIELDS)
def test_dose_expression_is_forbidden(
    dotted: str, path: str, max_length: int, dose: str
) -> None:
    output = _with(_output(), dotted, f"Örnek {dose} metni")

    assert _issues(output) == _single(path, "FORBIDDEN_CONTENT")


# Doz kalıbı süre, öğün, yüzde, test adı ve gram gibi ifadeleri yakalamaz.
@pytest.mark.parametrize("text", SAFE_TEXTS)
def test_safe_texts_are_not_dose_expressions(text: str) -> None:
    assert not has_dose_expression(text)
    assert _ok(_with(_output(), "summary", text)).summary == text


# Doz kalıbı sözleşmedeki olumlu örneklerin hepsini yakalar.
@pytest.mark.parametrize("text", DOSE_TEXTS)
def test_dose_texts_are_detected(text: str) -> None:
    assert has_dose_expression(text)


# Test adları ve evidence doz kalıbıyla denetlenmez, yalnızca istekteki adlarla eşlenir.
def test_test_names_are_not_checked_for_doses() -> None:
    output = _with(_output(), "findings", [{"testName": "5 mg", "interpretation": "x"}])
    _with(output, "possibleConditions.0.evidence", ["5 mg"])
    _with(output, "possibleConditions.1.evidence", ["5 mg"])

    result = _ok(output, ("5 mg",))

    assert result.findings[0].test_name == "5 mg"


# Dizi alanları eksik ya da null ise REQUIRED, dizi değilse TYPE olur.
@pytest.mark.parametrize(
    ("value", "code"),
    [(MISSING, "REQUIRED"), (None, "REQUIRED"), ("x", "TYPE"), ({"a": 1}, "TYPE")],
)
@pytest.mark.parametrize(("name", "max_count"), ARRAYS)
def test_arrays_must_be_lists(
    name: str, max_count: int, value: object, code: str
) -> None:
    assert _issues(_with(_output(), name, value)) == _single(name, code)


# Dizilerin üst sınırı kabul edilir, bir fazlası COUNT olur.
@pytest.mark.parametrize(("name", "max_count"), ARRAYS)
def test_array_count_limits(name: str, max_count: int) -> None:
    names = tuple(f"T{index}" for index in range(max_count + 1))
    items = {
        "findings": [{"testName": n, "interpretation": "Yorum"} for n in names],
        "possibleConditions": [
            {
                "name": f"Durum {n}",
                "likelihood": "LOW",
                "evidence": [n],
                "explanation": "Açıklama",
            }
            for n in names
        ],
        "recommendations": [{"category": "CARE", "text": "Öneri"} for _ in names],
        "questionsForVet": ["Soru?" for _ in names],
    }[name]
    request = (*TEST_NAMES, *names)

    _ok(_with(_output(), name, items[:max_count]), request)
    assert _issues(_with(_output(), name, items), request) == _single(name, "COUNT")


# Nesne olmayan liste kalemi TYPE olur, diğer kalemler yine denetlenir.
@pytest.mark.parametrize("item", [None, "x", 5, [], True])
@pytest.mark.parametrize(("name", "max_count"), OBJECT_ARRAYS)
def test_object_items_must_be_objects(name: str, max_count: int, item: object) -> None:
    output = _output()
    output[name][0] = item
    first_key = next(iter(EXAMPLE[name][1]))
    output[name][1][first_key] = ""

    assert _issues(output) == (
        ValidationIssue(f"{name}[0]", "TYPE"),
        ValidationIssue(f"{name}[1].{first_key}", "REQUIRED"),
    )


# testName boş, eksik ya da metin değilse uygun sorunu bildirir.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("", "REQUIRED"),
        (5, "TYPE"),
        (["HCT"], "TYPE"),
    ],
)
def test_invalid_test_name(value: object, code: str) -> None:
    output = _with(_output(), "findings.0.testName", value)

    assert _issues(output) == _single("findings[0].testName", code)


# testName ve evidence istekteki adlardan biriyle birebir aynı olmalıdır.
@pytest.mark.parametrize("value", ["hct", "Hct", "HCT2", "HC T", "Glukoz", "HCT."])
@pytest.mark.parametrize(
    ("dotted", "path"),
    [
        ("findings.0.testName", "findings[0].testName"),
        ("possibleConditions.1.evidence.0", "possibleConditions[1].evidence[0]"),
    ],
)
def test_unknown_name_is_enum_error(dotted: str, path: str, value: str) -> None:
    assert _issues(_with(_output(), dotted, value)) == _single(path, "ENUM")


# Kenar boşlukları kırpıldıktan sonra eşleşen ad kabul edilir.
def test_names_match_after_trim() -> None:
    output = _with(_output(), "findings.0.testName", " HCT\n")
    _with(output, "possibleConditions.1.evidence.0", chr(0x3000) + "HCT")

    result = _ok(output)

    assert result.findings[0].test_name == "HCT"
    assert result.possible_conditions[1].evidence == ("HCT",)


# Aynı test findings listesinde kırpılmış adıyla ikinci kez geçerse DUPLICATE olur.
def test_duplicate_finding() -> None:
    output = _with(_output(), "findings.1.testName", " HCT ")

    assert _issues(output) == _single("findings[1].testName", "DUPLICATE")


# Aynı ad bir evidence listesinde iki kez geçerse DUPLICATE olur.
def test_duplicate_evidence() -> None:
    output = _with(_output(), "possibleConditions.0.evidence", ["HGB", "HCT", "HGB"])

    assert _issues(output) == _single("possibleConditions[0].evidence[2]", "DUPLICATE")


# Aynı ad farklı olası durumların ve findings'in listelerinde ayrı ayrı geçebilir.
def test_same_name_in_different_lists_is_allowed() -> None:
    output = _with(_output(), "possibleConditions.1.evidence", ["HGB", "HCT"])

    result = _ok(output)

    assert result.possible_conditions[0].evidence == ("HCT", "HGB")
    assert result.possible_conditions[1].evidence == ("HGB", "HCT")


# evidence eksikse REQUIRED, dizi değilse TYPE, kalem sayısı 1-10 dışındaysa COUNT olur.
@pytest.mark.parametrize(
    ("value", "code"),
    [
        (MISSING, "REQUIRED"),
        (None, "REQUIRED"),
        ("HCT", "TYPE"),
        ({"0": "HCT"}, "TYPE"),
        ([], "COUNT"),
    ],
)
def test_invalid_evidence_list(value: object, code: str) -> None:
    output = _with(_output(), "possibleConditions.0.evidence", value)

    assert _issues(output) == _single("possibleConditions[0].evidence", code)


# evidence en fazla 10 ad içerir, 11 ad COUNT olur.
def test_evidence_count_limit() -> None:
    names = tuple(f"T{index}" for index in range(EVIDENCE_MAX + 1))
    request = (*TEST_NAMES, *names)
    output = _with(_output(), "possibleConditions.0.evidence", list(names[:-1]))

    assert len(_ok(output, request).possible_conditions[0].evidence) == 10
    _with(output, "possibleConditions.0.evidence", list(names))
    assert _issues(output, request) == _single(
        "possibleConditions[0].evidence", "COUNT"
    )


# Metin olmayan evidence kalemi TYPE, boş olanı REQUIRED olur.
@pytest.mark.parametrize(
    ("value", "code"),
    [(None, "TYPE"), (5, "TYPE"), (["HCT"], "TYPE"), ("", "REQUIRED")],
)
def test_invalid_evidence_item(value: object, code: str) -> None:
    output = _with(_output(), "possibleConditions.0.evidence.1", value)

    assert _issues(output) == _single("possibleConditions[0].evidence[1]", code)


# likelihood ve category yalnızca şemadaki seçeneklerden biri olur.
@pytest.mark.parametrize(
    ("dotted", "path", "options"),
    [
        (
            "possibleConditions.0.likelihood",
            "possibleConditions[0].likelihood",
            LIKELIHOODS,
        ),
        ("recommendations.0.category", "recommendations[0].category", CATEGORIES),
    ],
)
def test_choice_fields(dotted: str, path: str, options: tuple[str, ...]) -> None:
    for option in options:
        _ok(_with(_output(), dotted, f" {option} "))
    for value, code in (
        (MISSING, "REQUIRED"),
        ("", "REQUIRED"),
        (2, "TYPE"),
        ("MEDICATION", "ENUM"),
        (options[0].lower(), "ENUM"),
    ):
        assert _issues(_with(_output(), dotted, value)) == _single(path, code)


# Okunan seçenekler kırpılmış kısa adlardır.
def test_choices_are_trimmed() -> None:
    output = _with(_output(), "possibleConditions.0.likelihood", "\tHIGH ")
    _with(output, "recommendations.0.category", " NUTRITION")

    result = _ok(output)

    assert result.possible_conditions[0].likelihood == "HIGH"
    assert result.recommendations[0].category == "NUTRITION"


# Şema dışındaki alanlar yok sayılır ve sonuca taşınmaz.
def test_unknown_fields_are_ignored() -> None:
    output = _output()
    output["diagnosis"] = SECRET_MARKER
    output["findings"][0]["severity"] = SECRET_MARKER
    output["possibleConditions"][0]["dose"] = SECRET_MARKER
    output["recommendations"][0]["medication"] = SECRET_MARKER

    result = _ok(output)

    assert SECRET_MARKER not in repr(result)


# Birden çok kural ihlali alan yolu ve sayısal dizi sırasıyla bildirilir.
def test_issues_are_reported_in_path_order() -> None:
    output = _output()
    output["confidence"] = "yüksek"
    output["summary"] = "5 mg verin"
    output["findings"][1]["testName"] = "HCT"
    output["possibleConditions"][1]["evidence"] = ["Yok"]
    output["recommendations"][0]["category"] = "DRUG"
    output["questionsForVet"][2] = "x" * 301

    assert _issues(output, has_critical=True) == (
        ValidationIssue("confidence", "TYPE"),
        ValidationIssue("findings[1].testName", "DUPLICATE"),
        ValidationIssue("possibleConditions[1].evidence[0]", "ENUM"),
        ValidationIssue("questionsForVet[2]", "LENGTH"),
        ValidationIssue("recommendations[0].category", "ENUM"),
        ValidationIssue("riskLevel", "RISK_FLOOR"),
        ValidationIssue("summary", "FORBIDDEN_CONTENT"),
    )


# Aynı alanda birden çok kural ihlali ayrı kodlarla bildirilir.
def test_one_field_can_have_several_codes() -> None:
    output = _with(_output(), "summary", "5 mg " + "ş" * 2001 + "\tş")

    assert _issues(output) == (
        ValidationIssue("summary", "CONTROL_CHAR"),
        ValidationIssue("summary", "FORBIDDEN_CONTENT"),
        ValidationIssue("summary", "LENGTH"),
    )


# Doğrulama hatası ortak tabandan gelir; metni ve repr'i çıktı değerlerini içermez.
def test_assessment_invalid_hides_output_values() -> None:
    output = _with(_output(), "summary", SECRET_MARKER * 200)
    _with(output, "findings.0.testName", SECRET_MARKER)

    with pytest.raises(AssessmentInvalid) as caught:
        _ok(output)

    assert isinstance(caught.value, OutputInvalid)
    assert str(caught.value) == "Model çıktısı doğrulanamadı (2 sorun)"
    assert SECRET_MARKER not in repr(caught.value)
    assert all(SECRET_MARKER not in repr(issue) for issue in caught.value.issues)


# Sorun kodları açıklama kodları, FORBIDDEN_CONTENT ve RISK_FLOOR'dur.
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
        "FORBIDDEN_CONTENT",
        "RISK_FLOOR",
    )


# Sınır sabitleri ve seçenekler talimattaki değerlerdir.
def test_limits_and_options() -> None:
    assert (SUMMARY_MAX_LENGTH, TEXT_MAX_LENGTH, QUESTION_MAX_LENGTH) == (
        2000,
        500,
        300,
    )
    assert NAME_MAX_LENGTH == 128
    assert (FINDINGS_MAX, CONDITIONS_MAX, RECOMMENDATIONS_MAX, QUESTIONS_MAX) == (
        50,
        10,
        15,
        10,
    )
    assert EVIDENCE_MAX == 10
    assert RISK_LEVELS == ("LOW", "MODERATE", "HIGH", "URGENT")
    assert LIKELIHOODS == ("LOW", "MEDIUM", "HIGH")
    assert CATEGORIES == (
        "NUTRITION",
        "CARE",
        "FOLLOW_UP_TEST",
        "VET_VISIT",
        "VACCINATION",
    )


# Sonuç ve parçaları değiştirilemez.
def test_result_is_frozen() -> None:
    result = _ok(_output())

    with pytest.raises(FrozenInstanceError):
        result.confidence = 0.1
    with pytest.raises(FrozenInstanceError):
        result.findings[0].test_name = "x"
