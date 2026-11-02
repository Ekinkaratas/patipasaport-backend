import time
from collections.abc import Callable, Collection, Mapping, Sequence
from datetime import date, datetime
from types import MappingProxyType

from app.assessments.analyze import Analysis, analyze
from app.assessments.knowledge import triggered_patterns
from app.assessments.validate import (
    AssessmentInvalid,
    AssessmentResult,
    validate_assessment,
)
from app.clock import elapsed_ms, format_time, utc_now
from app.errors import EXPLANATION_ERROR_MESSAGES, INVALID_AI_OUTPUT, PermanentError
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import ChatTurn, IncompleteOutputError, LlmClient, LlmReply
from app.llm.prompts import (
    ASSESS_PROMPT_VERSION,
    build_assess_system_prompt,
    build_assess_task_text,
    build_assessment_correction_text,
    model_version,
)
from app.llm.schemas import ASSESSMENT_SCHEMA, ASSESSMENT_SCHEMA_NAME
from app.logs import get_logger
from app.messaging.cloudevents import (
    HEALTH_ASSESSMENT_FAILED,
    HEALTH_ASSESSMENT_GENERATED,
    HEALTH_ASSESSMENT_REQUESTED,
    INVALID_DATA,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    build_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import Publisher
from app.messaging.topology import ASSESSMENT_PREFETCH, Topology
from app.validation import has_control_character, parse_date, text_length, trim

PROFILE_TEXT_MAX_LENGTH = 32
LAB_SERIES_MAX = 60
TEST_NAME_MAX_LENGTH = 128
MEASUREMENTS_MIN = 1
MEASUREMENTS_MAX = 6
VALUE_MAX_LENGTH = 64
UNIT_MAX_LENGTH = 32
REFERENCE_RANGE_MAX_LENGTH = 64
VACCINATIONS_MAX = 20
NAME_MAX_LENGTH = 128
BATCH_NUMBER_MAX_LENGTH = 64
PRESCRIPTIONS_MAX = 20
DOSAGE_MAX_LENGTH = 64
FREQUENCY_MAX_LENGTH = 64
DURATION_DAYS_MAX = 3650
INSTRUCTIONS_MAX_LENGTH = 1000
CLINICAL_NOTES_MAX = 20
NOTE_TITLE_MIN_LENGTH = 2
NOTE_TITLE_MAX_LENGTH = 128
NOTES_MAX_LENGTH = 1000

RISK_LEVEL_VALUES: Mapping[str, int] = MappingProxyType(
    {
        "LOW": medical_record_pb2.HEALTH_RISK_LOW,
        "MODERATE": medical_record_pb2.HEALTH_RISK_MODERATE,
        "HIGH": medical_record_pb2.HEALTH_RISK_HIGH,
        "URGENT": medical_record_pb2.HEALTH_RISK_URGENT,
    }
)
LIKELIHOOD_VALUES: Mapping[str, int] = MappingProxyType(
    {
        "LOW": medical_record_pb2.CONDITION_LIKELIHOOD_LOW,
        "MEDIUM": medical_record_pb2.CONDITION_LIKELIHOOD_MEDIUM,
        "HIGH": medical_record_pb2.CONDITION_LIKELIHOOD_HIGH,
    }
)
CATEGORY_VALUES: Mapping[str, int] = MappingProxyType(
    {
        "NUTRITION": medical_record_pb2.RECOMMENDATION_NUTRITION,
        "CARE": medical_record_pb2.RECOMMENDATION_CARE,
        "FOLLOW_UP_TEST": medical_record_pb2.RECOMMENDATION_FOLLOW_UP_TEST,
        "VET_VISIT": medical_record_pb2.RECOMMENDATION_VET_VISIT,
        "VACCINATION": medical_record_pb2.RECOMMENDATION_VACCINATION,
    }
)

_FLAG_VALUES = frozenset(medical_record_pb2.LabResultFlag.values())
_NOTE_TYPES = frozenset({medical_record_pb2.EXAMINATION, medical_record_pb2.SURGERY})
_log = get_logger("AssessmentPipeline")


# Olayın verisinin HealthAssessmentRequested olduğunu doğrulayıp döndürür.
def _requested(event: IncomingEvent) -> events_pb2.HealthAssessmentRequested:
    data = event.data
    if not isinstance(data, events_pb2.HealthAssessmentRequested):
        raise InvalidMessageError(INVALID_DATA)
    return data


# Kırpılmış metin sınırlar içindeyse ve yasak kontrol karakteri yoksa True verir.
def _is_text(
    value: str, min_length: int, max_length: int, *, multiline: bool = False
) -> bool:
    trimmed = trim(value)
    return min_length <= text_length(trimmed) <= max_length and not (
        has_control_character(trimmed, multiline=multiline)
    )


# Metnin geçerli bir YYYY-MM-DD tarihi olup olmadığını söyler.
def _is_date(value: str) -> bool:
    return parse_date(value) is not None


# Bir tahlil ölçümünün tarihini, değerini, birimini, aralığını ve işaretini denetler.
def _is_valid_measurement(measurement: events_pb2.LabMeasurement) -> bool:
    return (
        _is_date(measurement.sampled_at)
        and _is_text(measurement.value, 1, VALUE_MAX_LENGTH)
        and _is_text(measurement.unit, 0, UNIT_MAX_LENGTH)
        and _is_text(measurement.reference_range, 0, REFERENCE_RANGE_MAX_LENGTH)
        and measurement.flag in _FLAG_VALUES
    )


# Bir tahlil serisinin test adını, ölçüm sayısını ve ölçümlerini denetler.
def _is_valid_series(series: events_pb2.LabSeries) -> bool:
    return (
        _is_text(series.test_name, 1, TEST_NAME_MAX_LENGTH)
        and MEASUREMENTS_MIN <= len(series.measurements) <= MEASUREMENTS_MAX
        and all(_is_valid_measurement(item) for item in series.measurements)
    )


# Bir aşının adını, tarihlerini ve seri numarasını denetler.
def _is_valid_vaccination(vaccination: medical_record_pb2.VaccinationDetails) -> bool:
    return (
        _is_text(vaccination.vaccine_name, 1, NAME_MAX_LENGTH)
        and _is_date(vaccination.administered_at)
        and (not vaccination.next_due_at or _is_date(vaccination.next_due_at))
        and _is_text(vaccination.batch_number, 0, BATCH_NUMBER_MAX_LENGTH)
    )


# Bir reçetenin ilaç adını, doz, sıklık, süre, talimat ve tarihini denetler.
def _is_valid_prescription(
    prescription: medical_record_pb2.PrescriptionDetails,
) -> bool:
    return (
        _is_text(prescription.medication_name, 1, NAME_MAX_LENGTH)
        and _is_text(prescription.dosage, 0, DOSAGE_MAX_LENGTH)
        and _is_text(prescription.frequency, 0, FREQUENCY_MAX_LENGTH)
        and 0 <= prescription.duration_days <= DURATION_DAYS_MAX
        and _is_text(
            prescription.instructions, 0, INSTRUCTIONS_MAX_LENGTH, multiline=True
        )
        and _is_date(prescription.prescribed_at)
    )


# Bir klinik notunun türünü, başlığını, notunu ve tarihini denetler.
def _is_valid_note(note: events_pb2.ClinicalNote) -> bool:
    return (
        note.type in _NOTE_TYPES
        and _is_text(note.title, NOTE_TITLE_MIN_LENGTH, NOTE_TITLE_MAX_LENGTH)
        and _is_text(note.notes, 0, NOTES_MAX_LENGTH, multiline=True)
        and _is_date(note.recorded_at)
    )


# Liste en fazla verilen sayıda kalem içeriyorsa ve her kalem geçerliyse True verir.
def _all_valid[T](
    items: Collection[T], max_count: int, is_valid: Callable[[T], bool]
) -> bool:
    return len(items) <= max_count and all(is_valid(item) for item in items)


# Tahlil serilerinin test adlarının kırpıldıktan sonra tekrarsız olduğunu söyler.
def _has_unique_test_names(series: Collection[events_pb2.LabSeries]) -> bool:
    names = [trim(item.test_name) for item in series]
    return len(set(names)) == len(names)


# İsteğin kayıt listelerinden en az birinin dolu ve hepsinin geçerli olduğunu söyler.
def _has_valid_records(data: events_pb2.HealthAssessmentRequested) -> bool:
    return (
        bool(
            data.lab_series
            or data.vaccinations
            or data.prescriptions
            or data.clinical_notes
        )
        and _all_valid(data.lab_series, LAB_SERIES_MAX, _is_valid_series)
        and _has_unique_test_names(data.lab_series)
        and _all_valid(data.vaccinations, VACCINATIONS_MAX, _is_valid_vaccination)
        and _all_valid(data.prescriptions, PRESCRIPTIONS_MAX, _is_valid_prescription)
        and _all_valid(data.clinical_notes, CLINICAL_NOTES_MAX, _is_valid_note)
    )


# İsteğin tarihlerini, profil alanlarını ve kayıtlarını denetler; tarihleri döndürür.
def _check_fields(
    data: events_pb2.HealthAssessmentRequested,
) -> tuple[date, date | None]:
    as_of = parse_date(data.as_of)
    birth_date = parse_date(data.birth_date) if data.birth_date else None
    if (
        as_of is None
        or (data.birth_date and birth_date is None)
        or not _is_text(data.species, 0, PROFILE_TEXT_MAX_LENGTH)
        or not _is_text(data.breed, 0, PROFILE_TEXT_MAX_LENGTH)
        or not _is_text(data.sex, 0, PROFILE_TEXT_MAX_LENGTH)
        or not _has_valid_records(data)
    ):
        raise InvalidMessageError(INVALID_DATA)
    return as_of, birth_date


# Doğrulanmış model çıktısını ve kodun bulgularını HealthAssessment mesajına çevirir.
def _build_assessment(
    result: AssessmentResult, analysis: Analysis
) -> medical_record_pb2.HealthAssessment:
    trends = {finding.test_name: finding.trend for finding in analysis.findings}
    return medical_record_pb2.HealthAssessment(
        summary=result.summary,
        risk_level=RISK_LEVEL_VALUES[result.risk_level],
        findings=[
            medical_record_pb2.HealthFinding(
                test_name=finding.test_name,
                trend=trends[finding.test_name],
                interpretation=finding.interpretation,
            )
            for finding in result.findings
        ],
        possible_conditions=[
            medical_record_pb2.PossibleCondition(
                name=condition.name,
                likelihood=LIKELIHOOD_VALUES[condition.likelihood],
                evidence=condition.evidence,
                explanation=condition.explanation,
            )
            for condition in result.possible_conditions
        ],
        recommendations=[
            medical_record_pb2.HealthRecommendation(
                category=CATEGORY_VALUES[recommendation.category],
                text=recommendation.text,
            )
            for recommendation in result.recommendations
        ],
        vaccination_reminders=[
            medical_record_pb2.VaccinationReminder(
                vaccine_name=reminder.vaccine_name,
                next_due_at=reminder.next_due_at,
                status=reminder.status,
            )
            for reminder in analysis.reminders
        ],
        questions_for_vet=result.questions,
    )


class AssessmentPipeline:
    # AI API istemcisini, kritik sapma eşiğini ve saati saklar, modelVersion'ı hesaplar.
    def __init__(
        self,
        llm: LlmClient,
        ai_model: str,
        critical_deviation_percent: float,
        *,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._llm = llm
        self._ai_model = ai_model
        self._critical_deviation_percent = critical_deviation_percent
        self._clock = clock
        self.model_version = model_version(ai_model, ASSESS_PROMPT_VERSION)

    # Değerlendirme kuyruğunu bu akışın işleyicisi ve hata olayı üreticisiyle eşler.
    def flow(self, topology: Topology) -> Flow:
        return Flow(
            queue=topology.assessment_queue,
            event_type=HEALTH_ASSESSMENT_REQUESTED,
            prefetch=ASSESSMENT_PREFETCH,
            handle=self.handle,
            build_failure=self.build_failure,
        )

    # Onaylı sağlık kayıtlarını inceleyip modele değerlendirtir ve sonucu yayınlar.
    async def handle(self, event: IncomingEvent, publisher: Publisher) -> None:
        started = time.monotonic()
        data = _requested(event)
        as_of, birth_date = _check_fields(data)
        analysis = analyze(
            data, as_of, critical_deviation_percent=self._critical_deviation_percent
        )
        system_prompt = build_assess_system_prompt(
            triggered_patterns(analysis, data.species)
        )
        task_text = build_assess_task_text(
            data, analysis, as_of=as_of, birth_date=birth_date
        )
        test_names = frozenset(
            trim(series.test_name) for series in data.lab_series if series.measurements
        )
        result = await self._assess(
            data.request_id,
            system_prompt,
            task_text,
            test_names,
            has_critical=analysis.has_critical,
        )
        generated_at = self._clock()
        await publisher.publish(
            build_event(
                events_pb2.HealthAssessmentGenerated(
                    request_id=data.request_id,
                    model_version=self.model_version,
                    confidence=result.confidence,
                    assessment=_build_assessment(result, analysis),
                    generated_at=format_time(generated_at),
                ),
                HEALTH_ASSESSMENT_GENERATED,
                now=generated_at,
            )
        )
        _log.info(
            "Sağlık değerlendirmesi üretildi ve yayınlandı",
            extra={
                "requestId": data.request_id,
                "durationMs": elapsed_ms(started),
                "model": self._ai_model,
            },
        )

    # Verilen hata koduyla health_assessment.failed olayını üretir.
    def build_failure(self, event: IncomingEvent, code: str) -> OutgoingEvent:
        data = _requested(event)
        failed_at = self._clock()
        return build_event(
            events_pb2.HealthAssessmentFailed(
                request_id=data.request_id,
                model_version=self.model_version,
                error_code=code,
                error_message=EXPLANATION_ERROR_MESSAGES[code],
                failed_at=format_time(failed_at),
            ),
            HEALTH_ASSESSMENT_FAILED,
            now=failed_at,
        )

    # Modeli çağırır; geçersiz ya da yarım çıktıda en fazla bir kez daha dener.
    async def _assess(
        self,
        request_id: str,
        system_prompt: str,
        task_text: str,
        test_names: frozenset[str],
        *,
        has_critical: bool,
    ) -> AssessmentResult:
        follow_up: tuple[ChatTurn, ...] = ()
        try:
            first = await self._complete(system_prompt, task_text, follow_up)
        except IncompleteOutputError:
            _log.warning(
                "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor",
                extra={"requestId": request_id},
            )
        else:
            try:
                return validate_assessment(
                    first.content, test_names, has_critical=has_critical
                )
            except AssessmentInvalid as error:
                _log.warning(
                    "Model çıktısı doğrulanamadı (%d sorun), düzeltme isteniyor",
                    len(error.issues),
                    extra={"requestId": request_id},
                )
                follow_up = (
                    ChatTurn("assistant", first.content),
                    ChatTurn("user", build_assessment_correction_text(error.issues)),
                )
        try:
            second = await self._complete(system_prompt, task_text, follow_up)
            return validate_assessment(
                second.content, test_names, has_critical=has_critical
            )
        except AssessmentInvalid, IncompleteOutputError:
            raise PermanentError(INVALID_AI_OUTPUT) from None

    # Talimat, görev metni ve şemayla görselsiz tek bir değerlendirme isteği gönderir.
    async def _complete(
        self, system_prompt: str, task_text: str, follow_up: Sequence[ChatTurn]
    ) -> LlmReply:
        return await self._llm.complete_json(
            system_prompt=system_prompt,
            user_text=task_text,
            image_data_urls=(),
            schema_name=ASSESSMENT_SCHEMA_NAME,
            schema=ASSESSMENT_SCHEMA,
            follow_up=follow_up,
        )
