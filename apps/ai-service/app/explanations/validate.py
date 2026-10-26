from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from app.generated import medical_record_pb2
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

DUPLICATE = "DUPLICATE"

ISSUE_CODES: tuple[str, ...] = (
    REQUIRED,
    TYPE,
    FORMAT,
    ENUM,
    LENGTH,
    COUNT,
    CONTROL_CHAR,
    DUPLICATE,
)

SUMMARY_MAX_LENGTH = 2000
EXPLANATION_MAX_LENGTH = 500
ITEMS_MAX = 50

_SUMMARY = "summary"
_ITEMS = "items"


class ExplanationInvalid(OutputInvalid):
    pass


@dataclass(frozen=True)
class ExplanationResult:
    explanation: medical_record_pb2.LabExplanation
    confidence: float


class _ExplanationReader:
    # Sorun listesini ve istekteki kırpılmış test adlarını saklar.
    def __init__(
        self, issues: list[ValidationIssue], test_names: frozenset[str]
    ) -> None:
        self._issues = issues
        self._test_names = test_names

    # Verilen alan yolu ve kural koduyla bir doğrulama sorunu ekler.
    def _add(self, path: str, code: str) -> None:
        self._issues.append(ValidationIssue(path, code))

    # Zorunlu metin alanını kırparak okur, kurallara göre denetler ve değeri döndürür.
    def text(
        self,
        source: Mapping[str, object],
        key: str,
        path: str,
        *,
        max_length: int | None,
        multiline: bool,
    ) -> str:
        raw = source.get(key)
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
        return value

    # items dizisini okur, kalem sayısını ve her kalemin alanlarını denetler.
    def items(self, raw: object) -> list[dict[str, str]]:
        if raw is None:
            self._add(_ITEMS, REQUIRED)
            return []
        if not isinstance(raw, list):
            self._add(_ITEMS, TYPE)
            return []
        if len(raw) > ITEMS_MAX:
            self._add(_ITEMS, COUNT)
        seen: set[str] = set()
        items: list[dict[str, str]] = []
        for index, item in enumerate(raw):
            path = f"{_ITEMS}[{index}]"
            if not isinstance(item, dict):
                self._add(path, TYPE)
                continue
            items.append(
                {
                    "test_name": self._test_name(item, f"{path}.testName", seen),
                    "explanation": self.text(
                        item,
                        "explanation",
                        f"{path}.explanation",
                        max_length=EXPLANATION_MAX_LENGTH,
                        multiline=True,
                    ),
                }
            )
        return items

    # testName'i okur; istekteki bir adla birebir aynı ve tekrarsız olmasını ister.
    def _test_name(self, item: Mapping[str, object], path: str, seen: set[str]) -> str:
        before = len(self._issues)
        value = self.text(item, "testName", path, max_length=None, multiline=False)
        if len(self._issues) > before:
            return value
        if value not in self._test_names:
            self._add(path, ENUM)
        elif value in seen:
            self._add(path, DUPLICATE)
        seen.add(value)
        return value


# Model çıktısını sözleşme 7.4'e göre doğrulayıp LabExplanation'a çevirir.
def validate_explanation(
    output: object, request_items: Iterable[medical_record_pb2.LabResultItem]
) -> ExplanationResult:
    data = decode_object(output)
    if data is None:
        raise ExplanationInvalid((ValidationIssue(ROOT_PATH, FORMAT),))
    issues: list[ValidationIssue] = []
    confidence = read_confidence(data.get("confidence"), issues)
    reader = _ExplanationReader(
        issues, frozenset(trim(item.test_name) for item in request_items)
    )
    summary = reader.text(
        data,
        _SUMMARY,
        _SUMMARY,
        max_length=SUMMARY_MAX_LENGTH,
        multiline=True,
    )
    items = reader.items(data.get(_ITEMS))
    if issues:
        raise ExplanationInvalid(issues)
    return ExplanationResult(
        explanation=medical_record_pb2.LabExplanation(summary=summary, items=items),
        confidence=confidence,
    )
