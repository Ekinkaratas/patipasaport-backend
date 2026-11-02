import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from app.explanations.validate import DUPLICATE
from app.validation import (
    CONTROL_CHAR,
    COUNT,
    ENUM,
    FORMAT,
    LENGTH,
    REQUIRED,
    ROOT_PATH,
    TYPE,
    OutputInvalid,
    ValidationIssue,
    decode_object,
    has_control_character,
    has_lone_surrogate,
    read_confidence,
    text_length,
    trim,
)

FORBIDDEN_CONTENT = "FORBIDDEN_CONTENT"
RISK_FLOOR = "RISK_FLOOR"

ISSUE_CODES: tuple[str, ...] = (
    REQUIRED,
    TYPE,
    FORMAT,
    ENUM,
    LENGTH,
    COUNT,
    CONTROL_CHAR,
    DUPLICATE,
    FORBIDDEN_CONTENT,
    RISK_FLOOR,
)

SUMMARY_MAX_LENGTH = 2000
TEXT_MAX_LENGTH = 500
QUESTION_MAX_LENGTH = 300
NAME_MAX_LENGTH = 128
FINDINGS_MAX = 50
CONDITIONS_MAX = 10
RECOMMENDATIONS_MAX = 15
QUESTIONS_MAX = 10
EVIDENCE_MIN = 1
EVIDENCE_MAX = 10

RISK_LEVELS: tuple[str, ...] = ("LOW", "MODERATE", "HIGH", "URGENT")
LIKELIHOODS: tuple[str, ...] = ("LOW", "MEDIUM", "HIGH")
CATEGORIES: tuple[str, ...] = (
    "NUTRITION",
    "CARE",
    "FOLLOW_UP_TEST",
    "VET_VISIT",
    "VACCINATION",
)
BELOW_FLOOR_RISK_LEVELS = frozenset({"LOW", "MODERATE"})

DOSE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?<![\w.,])\d+(?:[.,]\d+)?\s*"
        r"(?:mg|mcg|µg|μg|g|ml|iu|ünite|tablet|kapsül|damla)(?!\w)",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:mg|ml)\s*/\s*kg\b", re.IGNORECASE),
)

_RISK_LEVEL = "riskLevel"
_SUMMARY = "summary"
_FINDINGS = "findings"
_CONDITIONS = "possibleConditions"
_RECOMMENDATIONS = "recommendations"
_QUESTIONS = "questionsForVet"


class AssessmentInvalid(OutputInvalid):
    pass


@dataclass(frozen=True)
class AssessmentFinding:
    test_name: str
    interpretation: str


@dataclass(frozen=True)
class AssessmentCondition:
    name: str
    likelihood: str
    evidence: tuple[str, ...]
    explanation: str


@dataclass(frozen=True)
class AssessmentRecommendation:
    category: str
    text: str


@dataclass(frozen=True)
class AssessmentResult:
    confidence: float
    risk_level: str
    summary: str
    findings: tuple[AssessmentFinding, ...]
    possible_conditions: tuple[AssessmentCondition, ...]
    recommendations: tuple[AssessmentRecommendation, ...]
    questions: tuple[str, ...]


# Metinde sayıyla birlikte bir doz ya da miktar ifadesi geçip geçmediğini söyler.
def has_dose_expression(value: str) -> bool:
    return any(pattern.search(value) for pattern in DOSE_PATTERNS)


class _AssessmentReader:
    # Sorun listesini ve istekteki kırpılmış test adlarını saklar.
    def __init__(
        self, issues: list[ValidationIssue], test_names: frozenset[str]
    ) -> None:
        self._issues = issues
        self._test_names = test_names

    # Verilen alan yolu ve kural koduyla bir doğrulama sorunu ekler.
    def _add(self, path: str, code: str) -> None:
        self._issues.append(ValidationIssue(path, code))

    # Ham metni kırparak okur, kurallara göre denetler ve kırpılmış değeri döndürür.
    def text(
        self,
        raw: object,
        path: str,
        *,
        max_length: int | None,
        multiline: bool,
        check_dose: bool,
    ) -> str:
        if raw is None:
            self._add(path, REQUIRED)
            return ""
        if not isinstance(raw, str):
            self._add(path, TYPE)
            return ""
        value = trim(raw)
        if not value:
            self._add(path, REQUIRED)
            return ""
        if max_length is not None and text_length(value) > max_length:
            self._add(path, LENGTH)
        if has_control_character(value, multiline=multiline):
            self._add(path, CONTROL_CHAR)
        if has_lone_surrogate(value):
            self._add(path, FORMAT)
        if check_dose and has_dose_expression(value):
            self._add(path, FORBIDDEN_CONTENT)
        return value

    # Seçenek alanını kırparak okur ve izin verilen değerlerden biri olmasını ister.
    def choice(self, raw: object, path: str, options: tuple[str, ...]) -> str:
        if raw is None:
            self._add(path, REQUIRED)
            return ""
        if not isinstance(raw, str):
            self._add(path, TYPE)
            return ""
        value = trim(raw)
        if not value:
            self._add(path, REQUIRED)
            return ""
        if value not in options:
            self._add(path, ENUM)
        return value

    # Dizi alanını okur; kalem sayısı sınır dışındaysa COUNT ekler.
    def array(
        self, raw: object, path: str, *, max_count: int, min_count: int = 0
    ) -> list[object]:
        if raw is None:
            self._add(path, REQUIRED)
            return []
        if not isinstance(raw, list):
            self._add(path, TYPE)
            return []
        if not min_count <= len(raw) <= max_count:
            self._add(path, COUNT)
        return raw

    # Dizinin nesne kalemlerini yollarıyla verir, nesne olmayanlar için TYPE ekler.
    def objects(
        self, items: list[object], path: str
    ) -> list[tuple[str, Mapping[str, object]]]:
        found: list[tuple[str, Mapping[str, object]]] = []
        for index, item in enumerate(items):
            item_path = f"{path}[{index}]"
            if isinstance(item, dict):
                found.append((item_path, item))
            else:
                self._add(item_path, TYPE)
        return found

    # Dizinin metin kalemlerini yollarıyla verir, metin olmayanlar için TYPE ekler.
    def strings(self, items: list[object], path: str) -> list[tuple[str, str]]:
        found: list[tuple[str, str]] = []
        for index, item in enumerate(items):
            item_path = f"{path}[{index}]"
            if isinstance(item, str):
                found.append((item_path, item))
            else:
                self._add(item_path, TYPE)
        return found

    # Test adını okur; istekteki bir adla birebir aynı ve listede tekrarsız ister.
    def test_name(self, raw: object, path: str, seen: set[str]) -> str:
        before = len(self._issues)
        value = self.text(raw, path, max_length=None, multiline=False, check_dose=False)
        if len(self._issues) > before:
            return value
        if value not in self._test_names:
            self._add(path, ENUM)
        elif value in seen:
            self._add(path, DUPLICATE)
        seen.add(value)
        return value

    # findings dizisini okur, her kalemin testName ve interpretation alanını denetler.
    def findings(self, raw: object) -> tuple[AssessmentFinding, ...]:
        items = self.array(raw, _FINDINGS, max_count=FINDINGS_MAX)
        seen: set[str] = set()
        return tuple(
            AssessmentFinding(
                test_name=self.test_name(
                    item.get("testName"), f"{path}.testName", seen
                ),
                interpretation=self.text(
                    item.get("interpretation"),
                    f"{path}.interpretation",
                    max_length=TEXT_MAX_LENGTH,
                    multiline=True,
                    check_dose=True,
                ),
            )
            for path, item in self.objects(items, _FINDINGS)
        )

    # possibleConditions dizisini okur, ad, olasılık, kanıt ve açıklamayı denetler.
    def conditions(self, raw: object) -> tuple[AssessmentCondition, ...]:
        items = self.array(raw, _CONDITIONS, max_count=CONDITIONS_MAX)
        return tuple(
            AssessmentCondition(
                name=self.text(
                    item.get("name"),
                    f"{path}.name",
                    max_length=NAME_MAX_LENGTH,
                    multiline=False,
                    check_dose=True,
                ),
                likelihood=self.choice(
                    item.get("likelihood"), f"{path}.likelihood", LIKELIHOODS
                ),
                evidence=self.evidence(item.get("evidence"), f"{path}.evidence"),
                explanation=self.text(
                    item.get("explanation"),
                    f"{path}.explanation",
                    max_length=TEXT_MAX_LENGTH,
                    multiline=True,
                    check_dose=True,
                ),
            )
            for path, item in self.objects(items, _CONDITIONS)
        )

    # Bir olası durumun evidence listesini okur; adları istekteki testlerle eşler.
    def evidence(self, raw: object, path: str) -> tuple[str, ...]:
        items = self.array(raw, path, max_count=EVIDENCE_MAX, min_count=EVIDENCE_MIN)
        seen: set[str] = set()
        return tuple(
            self.test_name(item, item_path, seen)
            for item_path, item in self.strings(items, path)
        )

    # recommendations dizisini okur, her önerinin kategorisini ve metnini denetler.
    def recommendations(self, raw: object) -> tuple[AssessmentRecommendation, ...]:
        items = self.array(raw, _RECOMMENDATIONS, max_count=RECOMMENDATIONS_MAX)
        return tuple(
            AssessmentRecommendation(
                category=self.choice(
                    item.get("category"), f"{path}.category", CATEGORIES
                ),
                text=self.text(
                    item.get("text"),
                    f"{path}.text",
                    max_length=TEXT_MAX_LENGTH,
                    multiline=True,
                    check_dose=True,
                ),
            )
            for path, item in self.objects(items, _RECOMMENDATIONS)
        )

    # questionsForVet dizisini okur, her sorunun metnini denetler.
    def questions(self, raw: object) -> tuple[str, ...]:
        items = self.array(raw, _QUESTIONS, max_count=QUESTIONS_MAX)
        return tuple(
            self.text(
                item,
                item_path,
                max_length=QUESTION_MAX_LENGTH,
                multiline=True,
                check_dose=True,
            )
            for item_path, item in self.strings(items, _QUESTIONS)
        )


# Model çıktısını sağlık değerlendirmesi kurallarına göre doğrulayıp döndürür.
def validate_assessment(
    output: object, test_names: Iterable[str], *, has_critical: bool
) -> AssessmentResult:
    data = decode_object(output)
    if data is None:
        raise AssessmentInvalid((ValidationIssue(ROOT_PATH, FORMAT),))
    issues: list[ValidationIssue] = []
    confidence = read_confidence(data.get("confidence"), issues)
    reader = _AssessmentReader(issues, frozenset(trim(name) for name in test_names))
    risk_level = reader.choice(data.get(_RISK_LEVEL), _RISK_LEVEL, RISK_LEVELS)
    if has_critical and risk_level in BELOW_FLOOR_RISK_LEVELS:
        issues.append(ValidationIssue(_RISK_LEVEL, RISK_FLOOR))
    summary = reader.text(
        data.get(_SUMMARY),
        _SUMMARY,
        max_length=SUMMARY_MAX_LENGTH,
        multiline=True,
        check_dose=True,
    )
    findings = reader.findings(data.get(_FINDINGS))
    conditions = reader.conditions(data.get(_CONDITIONS))
    recommendations = reader.recommendations(data.get(_RECOMMENDATIONS))
    questions = reader.questions(data.get(_QUESTIONS))
    if issues:
        raise AssessmentInvalid(issues)
    return AssessmentResult(
        confidence=confidence,
        risk_level=risk_level,
        summary=summary,
        findings=findings,
        possible_conditions=conditions,
        recommendations=recommendations,
        questions=questions,
    )
