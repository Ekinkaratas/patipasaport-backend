import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Any, NoReturn

REQUIRED = "REQUIRED"
TYPE = "TYPE"
FORMAT = "FORMAT"
ENUM = "ENUM"
LENGTH = "LENGTH"
COUNT = "COUNT"
CONTROL_CHAR = "CONTROL_CHAR"

ROOT_PATH = "$"
CONFIDENCE_PATH = "confidence"
MIN_DATE_YEAR = 1000

_TRIM_CHARACTERS = "".join(
    map(
        chr,
        (
            0x09,
            0x0A,
            0x0B,
            0x0C,
            0x0D,
            0x20,
            0xA0,
            0x1680,
            *range(0x2000, 0x200B),
            0x2028,
            0x2029,
            0x202F,
            0x205F,
            0x3000,
            0xFEFF,
        ),
    )
)
_VARIATION_SELECTORS = frozenset(map(chr, (0xFE0E, 0xFE0F)))
_LINE_BREAKS = frozenset(map(chr, (0x0A, 0x0D)))
DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[([0-9]+)\]")


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    code: str


# Sorunu, dizi sıralarını sayı olarak karşılaştıran alan yolu anahtarına çevirir.
def _issue_sort_key(
    issue: ValidationIssue,
) -> tuple[tuple[tuple[int, int, str], ...], str, str]:
    segments = tuple(
        (1, int(index), "") if index else (0, 0, name)
        for name, index in _PATH_TOKEN.findall(issue.path)
    )
    return segments, issue.path, issue.code


class OutputInvalid(Exception):
    # Sorunları tekrarsız ve yol sırasıyla saklar, hata metnine yalnızca sayıyı yazar.
    def __init__(self, issues: Iterable[ValidationIssue]) -> None:
        self.issues: tuple[ValidationIssue, ...] = tuple(
            sorted(set(issues), key=_issue_sort_key)
        )
        super().__init__(f"Model çıktısı doğrulanamadı ({len(self.issues)} sorun)")


# JSON'da standart dışı olan NaN ve Infinity sabitlerini reddeder.
def _reject_constant(name: str) -> NoReturn:
    raise ValueError("Standart dışı JSON sabiti")


# Model çıktısını gerekiyorsa katı JSON olarak çözer, nesne değilse None döndürür.
def decode_object(output: object) -> dict[str, Any] | None:
    decoded = output
    if isinstance(output, str):
        try:
            decoded = json.loads(output, parse_constant=_reject_constant)
        except ValueError, RecursionError:
            return None
    return decoded if isinstance(decoded, dict) else None


# Metni medical-record'daki JavaScript trim() ile aynı karakterleri atarak kırpar.
def trim(value: str) -> str:
    return value.strip(_TRIM_CHARACTERS)


# Metin uzunluğunu medical-record gibi varyasyon seçicisini saymadan bulur.
def text_length(value: str) -> int:
    length = len(value)
    index = 0
    while index < len(value) - 1:
        if (
            value[index] not in _VARIATION_SELECTORS
            and value[index + 1] in _VARIATION_SELECTORS
        ):
            length -= 1
            index += 2
        else:
            index += 1
    return length


# Metinde medical-record'un yasakladığı bir kontrol karakteri olup olmadığını söyler.
def has_control_character(value: str, *, multiline: bool) -> bool:
    for character in value:
        code = ord(character)
        if code >= 0x20 and code != 0x7F:
            continue
        if not (multiline and character in _LINE_BREAKS):
            return True
    return False


# Metinde UTF-8'e çevrilemeyen tek başına bir vekil karakter olup olmadığını söyler.
def has_lone_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(character) <= 0xDFFF for character in value)


# Metni YYYY-MM-DD biçiminde, geçerli ve yılı en az 1000 olan bir tarih olarak çözer.
def parse_date(value: str) -> date | None:
    if DATE_PATTERN.fullmatch(value) is None:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.year >= MIN_DATE_YEAR else None


# confidence değerini sayı olarak okuyup [0, 1] aralığına kırpar, geçersizse TYPE ekler.
def read_confidence(value: object, issues: list[ValidationIssue]) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        issues.append(ValidationIssue(CONFIDENCE_PATH, TYPE))
        return 0.0
    if isinstance(value, int):
        return float(min(max(value, 0), 1))
    if not math.isfinite(value):
        issues.append(ValidationIssue(CONFIDENCE_PATH, TYPE))
        return 0.0
    return max(0.0, min(1.0, value))
