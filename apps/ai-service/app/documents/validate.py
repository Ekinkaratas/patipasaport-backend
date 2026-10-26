import json
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from typing import Any, NoReturn
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.errors import NOT_A_MEDICAL_DOCUMENT, PermanentError
from app.generated import medical_record_pb2

REQUIRED = "REQUIRED"
TYPE = "TYPE"
FORMAT = "FORMAT"
ENUM = "ENUM"
LENGTH = "LENGTH"
RANGE = "RANGE"
COUNT = "COUNT"
CONTROL_CHAR = "CONTROL_CHAR"
FUTURE_DATE = "FUTURE_DATE"
ORDER = "ORDER"

ISSUE_CODES: tuple[str, ...] = (
    REQUIRED,
    TYPE,
    FORMAT,
    ENUM,
    LENGTH,
    RANGE,
    COUNT,
    CONTROL_CHAR,
    FUTURE_DATE,
    ORDER,
)

ROOT_PATH = "$"

TITLE_MIN_LENGTH = 2
TITLE_MAX_LENGTH = 128
NOTES_MAX_LENGTH = 2000
NAME_MAX_LENGTH = 128
SHORT_TEXT_MAX_LENGTH = 64
LAB_UNIT_MAX_LENGTH = 32
INSTRUCTIONS_MAX_LENGTH = 1000
DURATION_DAYS_MIN = 1
DURATION_DAYS_MAX = 365
LAB_ITEMS_MIN = 1
LAB_ITEMS_MAX = 50
MIN_DATE_YEAR = 1000
ESTIMATED_DATE_MAX_CONFIDENCE = 0.5

RECORD_TYPES: tuple[str, ...] = (
    "EXAMINATION",
    "VACCINATION",
    "PRESCRIPTION",
    "LAB_RESULT",
    "SURGERY",
)
LAB_RESULT_FLAGS: tuple[str, ...] = ("NORMAL", "LOW", "HIGH")

BUSINESS_TIME_ZONE_NAME = "Europe/Istanbul"

_PROPOSAL = "proposal"
_RECORDED_AT = f"{_PROPOSAL}.recordedAt"
_LAB_RESULT = f"{_PROPOSAL}.labResult"
_VACCINATION = f"{_PROPOSAL}.vaccination"
_PRESCRIPTION = f"{_PROPOSAL}.prescription"
_SAMPLED_AT = f"{_LAB_RESULT}.sampledAt"
_ADMINISTERED_AT = f"{_VACCINATION}.administeredAt"
_NEXT_DUE_AT = f"{_VACCINATION}.nextDueAt"
_PRESCRIBED_AT = f"{_PRESCRIPTION}.prescribedAt"

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
_DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[([0-9]+)\]")


# Europe/Istanbul saat dilimini yükler, saat dilimi verisi yoksa sabit UTC+3 kullanır.
def _load_business_time_zone() -> tzinfo:
    try:
        return ZoneInfo(BUSINESS_TIME_ZONE_NAME)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=3), BUSINESS_TIME_ZONE_NAME)


BUSINESS_TIME_ZONE = _load_business_time_zone()


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


class ExtractionInvalid(Exception):
    # Sorunları tekrarsız ve yol sırasıyla saklar, hata metnine yalnızca sayıyı yazar.
    def __init__(self, issues: Iterable[ValidationIssue]) -> None:
        self.issues: tuple[ValidationIssue, ...] = tuple(
            sorted(set(issues), key=_issue_sort_key)
        )
        super().__init__(f"Model çıktısı doğrulanamadı ({len(self.issues)} sorun)")


@dataclass(frozen=True)
class ExtractionResult:
    proposal: medical_record_pb2.RecordContent
    confidence: float
    date_estimated: bool


# JSON'da standart dışı olan NaN ve Infinity sabitlerini reddeder.
def _reject_constant(name: str) -> NoReturn:
    raise ValueError("Standart dışı JSON sabiti")


# Model çıktısını gerekiyorsa katı JSON olarak çözer ve bir nesne olduğunu doğrular.
def _decode_output(output: object) -> dict[str, Any]:
    decoded = output
    if isinstance(output, str):
        try:
            decoded = json.loads(output, parse_constant=_reject_constant)
        except ValueError, RecursionError:
            raise ExtractionInvalid((ValidationIssue(ROOT_PATH, FORMAT),)) from None
    if not isinstance(decoded, dict):
        raise ExtractionInvalid((ValidationIssue(ROOT_PATH, FORMAT),))
    return decoded


# Metni medical-record'daki JavaScript trim() ile aynı karakterleri atarak kırpar.
def _trim(value: str) -> str:
    return value.strip(_TRIM_CHARACTERS)


# Metin uzunluğunu medical-record gibi varyasyon seçicisini saymadan bulur.
def _text_length(value: str) -> int:
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
def _has_control_character(value: str, *, multiline: bool) -> bool:
    for character in value:
        code = ord(character)
        if code >= 0x20 and code != 0x7F:
            continue
        if not (multiline and character in _LINE_BREAKS):
            return True
    return False


# Metinde UTF-8'e çevrilemeyen tek başına bir vekil karakter olup olmadığını söyler.
def _has_lone_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(character) <= 0xDFFF for character in value)


# Metni YYYY-MM-DD biçiminde, geçerli ve yılı en az 1000 olan bir tarih olarak çözer.
def _parse_date(value: str) -> date | None:
    if _DATE_PATTERN.fullmatch(value) is None:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.year >= MIN_DATE_YEAR else None


# Zamanı Europe/Istanbul tarihine çevirir, saat dilimi olmayan zamanı UTC kabul eder.
def _business_date(moment: datetime) -> date:
    if moment.utcoffset() is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(BUSINESS_TIME_ZONE).date()


# confidence değerini sayı olarak okuyup [0, 1] aralığına kırpar, geçersizse TYPE ekler.
def _read_confidence(value: object, issues: list[ValidationIssue]) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        issues.append(ValidationIssue("confidence", TYPE))
        return 0.0
    if isinstance(value, int):
        return float(min(max(value, 0), 1))
    if not math.isfinite(value):
        issues.append(ValidationIssue("confidence", TYPE))
        return 0.0
    return max(0.0, min(1.0, value))


class _ProposalReader:
    # Sorun listesini, bugünün tarihini ve olayın İstanbul tarihini saklar.
    def __init__(
        self, issues: list[ValidationIssue], today: date, event_day: date
    ) -> None:
        self._issues = issues
        self._today = today
        self._event_day = event_day.isoformat()

    # Verilen alan yolu ve kural koduyla bir doğrulama sorunu ekler.
    def _add(self, path: str, code: str) -> None:
        self._issues.append(ValidationIssue(path, code))

    # proposal nesnesini okuyup RecordContent alanlarını ve tarih tahminini döndürür.
    def read(self, raw: object) -> tuple[dict[str, Any], bool]:
        if raw is None:
            self._add(_PROPOSAL, REQUIRED)
            return {}, False
        if not isinstance(raw, dict):
            self._add(_PROPOSAL, TYPE)
            return {}, False
        record_type = self._record_type(raw)
        values: dict[str, Any] = {
            "title": self._text(
                raw,
                "title",
                f"{_PROPOSAL}.title",
                required=True,
                min_length=TITLE_MIN_LENGTH,
                max_length=TITLE_MAX_LENGTH,
            ),
            "notes": self._text(
                raw,
                "notes",
                f"{_PROPOSAL}.notes",
                required=False,
                max_length=NOTES_MAX_LENGTH,
                multiline=True,
            ),
        }
        recorded = self._date_text(raw, "recordedAt", _RECORDED_AT)
        if record_type is None:
            if recorded:
                self._check_date(recorded, _RECORDED_AT)
            return values, False
        values["type"] = medical_record_pb2.RecordType.Value(record_type)
        if record_type in ("EXAMINATION", "SURGERY"):
            values["recorded_at"], estimated = self._single_date(recorded)
            return values, estimated
        details_key = {
            "LAB_RESULT": "labResult",
            "VACCINATION": "vaccination",
            "PRESCRIPTION": "prescription",
        }[record_type]
        source = self._details(raw, details_key)
        if source is None:
            if recorded:
                self._check_date(recorded, _RECORDED_AT)
            return values, False
        if record_type == "LAB_RESULT":
            details, values["recorded_at"], estimated = self._lab_result(
                source, recorded
            )
        elif record_type == "VACCINATION":
            details, values["recorded_at"], estimated = self._vaccination(
                source, recorded
            )
        else:
            details, values["recorded_at"], estimated = self._prescription(
                source, recorded
            )
        values.update(details)
        return values, estimated

    # Kayıt türünü okur ve beş geçerli türden biri değilse uygun sorunu ekler.
    def _record_type(self, proposal: Mapping[str, Any]) -> str | None:
        path = f"{_PROPOSAL}.type"
        raw = proposal.get("type")
        if raw is None:
            self._add(path, REQUIRED)
            return None
        if not isinstance(raw, str):
            self._add(path, TYPE)
            return None
        value = _trim(raw)
        if not value:
            self._add(path, REQUIRED)
            return None
        if value not in RECORD_TYPES:
            self._add(path, ENUM)
            return None
        return value

    # Metin alanını kırparak okur, kurallara göre denetler ve kırpılmış değeri döndürür.
    def _text(
        self,
        source: Mapping[str, Any],
        key: str,
        path: str,
        *,
        required: bool,
        max_length: int,
        min_length: int = 0,
        multiline: bool = False,
    ) -> str:
        raw = source.get(key)
        if raw is None:
            value = ""
        elif isinstance(raw, str):
            value = _trim(raw)
        else:
            self._add(path, TYPE)
            return ""
        if not value:
            if required:
                self._add(path, REQUIRED)
            return ""
        if not min_length <= _text_length(value) <= max_length:
            self._add(path, LENGTH)
        if _has_control_character(value, multiline=multiline):
            self._add(path, CONTROL_CHAR)
        if _has_lone_surrogate(value):
            self._add(path, FORMAT)
        return value

    # Tarih alanını kırparak okur, metin değilse TYPE ekleyip None döndürür.
    def _date_text(self, source: Mapping[str, Any], key: str, path: str) -> str | None:
        raw = source.get(key)
        if raw is None:
            return ""
        if not isinstance(raw, str):
            self._add(path, TYPE)
            return None
        return _trim(raw)

    # Dolu bir tarihi biçim ve istenirse gelecek tarih kuralıyla denetler.
    def _check_date(self, value: str, path: str, *, not_future: bool = True) -> bool:
        parsed = _parse_date(value)
        if parsed is None:
            self._add(path, FORMAT)
            return False
        if not_future and parsed > self._today:
            self._add(path, FUTURE_DATE)
            return False
        return True

    # Ayrıntısız türlerde recordedAt'i denetler, boşsa olayın tarihiyle tamamlar.
    def _single_date(self, recorded: str | None) -> tuple[str, bool]:
        if recorded == "":
            self._check_date(self._event_day, _RECORDED_AT)
            return self._event_day, True
        if recorded:
            self._check_date(recorded, _RECORDED_AT)
        return recorded or "", False

    # recordedAt ile türün zorunlu tarihini denetler ve boş olanı tamamlar.
    def _paired_dates(
        self, recorded: str | None, detail: str | None, detail_path: str
    ) -> tuple[str, str, bool]:
        if recorded == "" and detail == "":
            self._check_date(self._event_day, _RECORDED_AT)
            self._check_date(self._event_day, detail_path)
            return self._event_day, self._event_day, True
        recorded_valid = False
        if recorded:
            recorded_valid = self._check_date(recorded, _RECORDED_AT)
        detail_valid = False
        if detail:
            detail_valid = self._check_date(detail, detail_path)
        if recorded == "" and detail and detail_valid:
            return detail, detail, False
        if detail == "" and recorded and recorded_valid:
            return recorded, recorded, False
        return recorded or "", detail or "", False

    # Türün ayrıntı nesnesini okur, yoksa REQUIRED ve nesne değilse TYPE ekler.
    def _details(
        self, proposal: Mapping[str, Any], key: str
    ) -> Mapping[str, Any] | None:
        path = f"{_PROPOSAL}.{key}"
        raw = proposal.get(key)
        if raw is None:
            self._add(path, REQUIRED)
            return None
        if not isinstance(raw, dict):
            self._add(path, TYPE)
            return None
        return raw

    # Tahlil ayrıntısını okur, tarihleri tamamlar ve RecordContent alanlarını döndürür.
    def _lab_result(
        self, source: Mapping[str, Any], recorded: str | None
    ) -> tuple[dict[str, Any], str, bool]:
        items = self._lab_items(source)
        sampled = self._date_text(source, "sampledAt", _SAMPLED_AT)
        recorded_at, sampled_at, estimated = self._paired_dates(
            recorded, sampled, _SAMPLED_AT
        )
        details = {"lab_result": {"items": items, "sampled_at": sampled_at}}
        return details, recorded_at, estimated

    # Tahlil kalemlerini okur, kalem sayısını ve her kalemin alanlarını denetler.
    def _lab_items(self, source: Mapping[str, Any]) -> list[dict[str, Any]]:
        path = f"{_LAB_RESULT}.items"
        raw = source.get("items")
        if raw is None:
            self._add(path, REQUIRED)
            return []
        if not isinstance(raw, list):
            self._add(path, TYPE)
            return []
        if len(raw) < LAB_ITEMS_MIN:
            self._add(path, REQUIRED)
            return []
        if len(raw) > LAB_ITEMS_MAX:
            self._add(path, COUNT)
        items: list[dict[str, Any]] = []
        for index, item in enumerate(raw):
            item_path = f"{path}[{index}]"
            if not isinstance(item, dict):
                self._add(item_path, TYPE)
                continue
            items.append(self._lab_item(item, item_path))
        return items

    # Tek bir tahlil kalemini okur ve proto alan adlarıyla döndürür.
    def _lab_item(self, item: Mapping[str, Any], path: str) -> dict[str, Any]:
        return {
            "test_name": self._text(
                item,
                "testName",
                f"{path}.testName",
                required=True,
                max_length=NAME_MAX_LENGTH,
            ),
            "value": self._text(
                item,
                "value",
                f"{path}.value",
                required=True,
                max_length=SHORT_TEXT_MAX_LENGTH,
            ),
            "unit": self._text(
                item,
                "unit",
                f"{path}.unit",
                required=False,
                max_length=LAB_UNIT_MAX_LENGTH,
            ),
            "reference_range": self._text(
                item,
                "referenceRange",
                f"{path}.referenceRange",
                required=False,
                max_length=SHORT_TEXT_MAX_LENGTH,
            ),
            "flag": self._flag(item, f"{path}.flag"),
        }

    # flag değerini okur, boşsa LAB_RESULT_FLAG_UNSPECIFIED döndürür.
    def _flag(self, item: Mapping[str, Any], path: str) -> int:
        unspecified = medical_record_pb2.LabResultFlag.Value(
            "LAB_RESULT_FLAG_UNSPECIFIED"
        )
        raw = item.get("flag")
        if raw is None:
            return unspecified
        if not isinstance(raw, str):
            self._add(path, TYPE)
            return unspecified
        value = _trim(raw)
        if not value:
            return unspecified
        if value not in LAB_RESULT_FLAGS:
            self._add(path, ENUM)
            return unspecified
        return medical_record_pb2.LabResultFlag.Value(value)

    # Aşı ayrıntısını okur, tarihleri tamamlar ve sonraki aşı tarihini denetler.
    def _vaccination(
        self, source: Mapping[str, Any], recorded: str | None
    ) -> tuple[dict[str, Any], str, bool]:
        vaccine_name = self._text(
            source,
            "vaccineName",
            f"{_VACCINATION}.vaccineName",
            required=True,
            max_length=NAME_MAX_LENGTH,
        )
        batch_number = self._text(
            source,
            "batchNumber",
            f"{_VACCINATION}.batchNumber",
            required=False,
            max_length=SHORT_TEXT_MAX_LENGTH,
        )
        administered = self._date_text(source, "administeredAt", _ADMINISTERED_AT)
        next_due = self._date_text(source, "nextDueAt", _NEXT_DUE_AT)
        recorded_at, administered_at, estimated = self._paired_dates(
            recorded, administered, _ADMINISTERED_AT
        )
        if (
            next_due
            and self._check_date(next_due, _NEXT_DUE_AT, not_future=False)
            and _DATE_PATTERN.fullmatch(administered_at)
            and next_due <= administered_at
        ):
            self._add(_NEXT_DUE_AT, ORDER)
        details = {
            "vaccination": {
                "vaccine_name": vaccine_name,
                "batch_number": batch_number,
                "administered_at": administered_at,
                "next_due_at": next_due or "",
            }
        }
        return details, recorded_at, estimated

    # durationDays değerini tam sayı olarak okur ve 1–365 aralığını denetler.
    def _duration_days(self, source: Mapping[str, Any]) -> int:
        path = f"{_PRESCRIPTION}.durationDays"
        raw = source.get("durationDays")
        if raw is None:
            self._add(path, REQUIRED)
            return 0
        if isinstance(raw, float) and raw.is_integer():
            raw = int(raw)
        if isinstance(raw, bool) or not isinstance(raw, int):
            self._add(path, TYPE)
            return 0
        if not DURATION_DAYS_MIN <= raw <= DURATION_DAYS_MAX:
            self._add(path, RANGE)
            return 0
        return raw

    # Reçete ayrıntısını okur, tarihleri tamamlar ve RecordContent alanlarını döndürür.
    def _prescription(
        self, source: Mapping[str, Any], recorded: str | None
    ) -> tuple[dict[str, Any], str, bool]:
        medication_name = self._text(
            source,
            "medicationName",
            f"{_PRESCRIPTION}.medicationName",
            required=True,
            max_length=NAME_MAX_LENGTH,
        )
        dosage = self._text(
            source,
            "dosage",
            f"{_PRESCRIPTION}.dosage",
            required=True,
            max_length=SHORT_TEXT_MAX_LENGTH,
        )
        frequency = self._text(
            source,
            "frequency",
            f"{_PRESCRIPTION}.frequency",
            required=True,
            max_length=SHORT_TEXT_MAX_LENGTH,
        )
        duration_days = self._duration_days(source)
        instructions = self._text(
            source,
            "instructions",
            f"{_PRESCRIPTION}.instructions",
            required=False,
            max_length=INSTRUCTIONS_MAX_LENGTH,
            multiline=True,
        )
        prescribed = self._date_text(source, "prescribedAt", _PRESCRIBED_AT)
        recorded_at, prescribed_at, estimated = self._paired_dates(
            recorded, prescribed, _PRESCRIBED_AT
        )
        details = {
            "prescription": {
                "medication_name": medication_name,
                "dosage": dosage,
                "frequency": frequency,
                "duration_days": duration_days,
                "instructions": instructions,
                "prescribed_at": prescribed_at,
            }
        }
        return details, recorded_at, estimated


# Model çıktısını sözleşme 6.5 ve 6.6'ya göre doğrulayıp RecordContent'e çevirir.
def validate_extraction(
    output: object, *, event_time: datetime, today: date | None = None
) -> ExtractionResult:
    data = _decode_output(output)
    is_medical_document = data.get("isMedicalDocument")
    if is_medical_document is False:
        raise PermanentError(NOT_A_MEDICAL_DOCUMENT)
    issues: list[ValidationIssue] = []
    if not isinstance(is_medical_document, bool):
        issues.append(ValidationIssue("isMedicalDocument", TYPE))
    confidence = _read_confidence(data.get("confidence"), issues)
    reference_day = (
        today if today is not None else datetime.now(BUSINESS_TIME_ZONE).date()
    )
    reader = _ProposalReader(issues, reference_day, _business_date(event_time))
    values, date_estimated = reader.read(data.get("proposal"))
    if issues:
        raise ExtractionInvalid(issues)
    if date_estimated:
        confidence = min(confidence, ESTIMATED_DATE_MAX_CONFIDENCE)
    return ExtractionResult(
        proposal=medical_record_pb2.RecordContent(**values),
        confidence=confidence,
        date_estimated=date_estimated,
    )
