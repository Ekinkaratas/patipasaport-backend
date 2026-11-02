import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from itertools import pairwise
from types import MappingProxyType

from app.generated import events_pb2, medical_record_pb2
from app.validation import parse_date, trim

STATUS_LOW = "LOW"
STATUS_HIGH = "HIGH"
STATUS_NORMAL = "NORMAL"
STATUS_UNKNOWN = "UNKNOWN"
DUE_SOON_DAYS = 30
TREND_WINDOW = 3

_NUMBER_PATTERN = re.compile(r"-?[0-9]+(?:[.,][0-9]+)?")
_RANGE_PATTERN = re.compile(r"([^\-–—]*)[\-–—]([^\-–—]*)")
_FLAG_STATUSES: Mapping[int, str] = MappingProxyType(
    {
        medical_record_pb2.LOW: STATUS_LOW,
        medical_record_pb2.HIGH: STATUS_HIGH,
        medical_record_pb2.NORMAL: STATUS_NORMAL,
    }
)


@dataclass(frozen=True)
class ReferenceRange:
    low: float
    high: float


@dataclass(frozen=True)
class SeriesFinding:
    test_name: str
    latest_value: str
    unit: str
    reference_range: str
    status: str
    deviation_percent: float | None
    trend: int
    critical: bool
    measurement_count: int


@dataclass(frozen=True)
class VaccinationReminderInfo:
    vaccine_name: str
    next_due_at: str
    status: int


@dataclass(frozen=True)
class Analysis:
    findings: tuple[SeriesFinding, ...]
    reminders: tuple[VaccinationReminderInfo, ...]
    has_critical: bool


# Metni isteğe bağlı eksi ve nokta ya da virgüllü ondalıkla sonlu bir sayıya çevirir.
def parse_number(value: str) -> float | None:
    trimmed = trim(value)
    if _NUMBER_PATTERN.fullmatch(trimmed) is None:
        return None
    number = float(trimmed.replace(",", "."))
    return number if math.isfinite(number) else None


# "alt-üst" biçimindeki referans aralığını tek bir tire ya da uzun çizgiyle çözer.
def parse_reference_range(value: str) -> ReferenceRange | None:
    match = _RANGE_PATTERN.fullmatch(trim(value))
    if match is None:
        return None
    low = parse_number(match.group(1))
    high = parse_number(match.group(2))
    if low is None or high is None or low >= high:
        return None
    return ReferenceRange(low, high)


# Değeri aralıkla karşılaştırıp durumu ve aralık genişliğine göre sapma yüzdesini verir.
def _compare(value: float, reference: ReferenceRange) -> tuple[str, float]:
    width = reference.high - reference.low
    if value < reference.low:
        return STATUS_LOW, (reference.low - value) / width * 100
    if value > reference.high:
        return STATUS_HIGH, (value - reference.high) / width * 100
    return STATUS_NORMAL, 0.0


# Sayısal değerlerin son ölçümlerine bakarak serinin eğilimini belirler.
def _trend(measurements: Sequence[events_pb2.LabMeasurement]) -> int:
    numbers = [
        number
        for measurement in measurements
        if (number := parse_number(measurement.value)) is not None
    ][-TREND_WINDOW:]
    if not numbers:
        return (
            medical_record_pb2.LAB_TREND_UNSPECIFIED
            if len(measurements) > 1
            else medical_record_pb2.LAB_TREND_SINGLE
        )
    if len(numbers) == 1:
        return medical_record_pb2.LAB_TREND_SINGLE
    steps = tuple(pairwise(numbers))
    if all(before < after for before, after in steps):
        return medical_record_pb2.LAB_TREND_RISING
    if all(before > after for before, after in steps):
        return medical_record_pb2.LAB_TREND_FALLING
    return medical_record_pb2.LAB_TREND_STABLE


# Bir tahlil serisinin en son ölçümünü durum, sapma, eğilim ve kritiklikle özetler.
def _finding(
    series: events_pb2.LabSeries, critical_deviation_percent: float
) -> SeriesFinding:
    measurements = sorted(series.measurements, key=lambda item: item.sampled_at)
    latest = measurements[-1]
    value = parse_number(latest.value)
    reference = parse_reference_range(latest.reference_range)
    deviation: float | None = None
    if value is not None and reference is not None:
        status, deviation = _compare(value, reference)
    else:
        status = _FLAG_STATUSES.get(latest.flag, STATUS_UNKNOWN)
    return SeriesFinding(
        test_name=trim(series.test_name),
        latest_value=trim(latest.value),
        unit=trim(latest.unit),
        reference_range=trim(latest.reference_range),
        status=status,
        deviation_percent=deviation,
        trend=_trend(measurements),
        critical=deviation is not None and deviation > critical_deviation_percent,
        measurement_count=len(measurements),
    )


# Aynı adlı aşıların en son yapılanına göre gecikmiş ya da yaklaşan aşıları listeler.
def _reminders(
    vaccinations: Sequence[medical_record_pb2.VaccinationDetails], as_of: date
) -> tuple[VaccinationReminderInfo, ...]:
    latest: dict[str, medical_record_pb2.VaccinationDetails] = {}
    for vaccination in vaccinations:
        key = trim(vaccination.vaccine_name).casefold()
        current = latest.get(key)
        if current is None or vaccination.administered_at >= current.administered_at:
            latest[key] = vaccination
    reminders: list[VaccinationReminderInfo] = []
    for vaccination in latest.values():
        due = parse_date(vaccination.next_due_at)
        if due is None:
            continue
        days_left = (due - as_of).days
        if days_left < 0:
            status = medical_record_pb2.VACCINATION_OVERDUE
        elif days_left <= DUE_SOON_DAYS:
            status = medical_record_pb2.VACCINATION_DUE_SOON
        else:
            continue
        reminders.append(
            VaccinationReminderInfo(
                vaccine_name=trim(vaccination.vaccine_name),
                next_due_at=due.isoformat(),
                status=status,
            )
        )
    return tuple(reminders)


# Sağlık değerlendirmesi isteğindeki tahlil serilerini ve aşıları kurallarla inceler.
def analyze(
    request: events_pb2.HealthAssessmentRequested,
    as_of: date,
    *,
    critical_deviation_percent: float,
) -> Analysis:
    findings = tuple(
        _finding(series, critical_deviation_percent)
        for series in request.lab_series
        if series.measurements
    )
    return Analysis(
        findings=findings,
        reminders=_reminders(request.vaccinations, as_of),
        has_critical=any(finding.critical for finding in findings),
    )
