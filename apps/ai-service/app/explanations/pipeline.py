import time
from collections.abc import Callable, Sequence
from datetime import date, datetime

from app.clock import elapsed_ms, format_time, utc_now
from app.errors import EXPLANATION_ERROR_MESSAGES, INVALID_AI_OUTPUT, PermanentError
from app.explanations.validate import (
    ExplanationInvalid,
    ExplanationResult,
    validate_explanation,
)
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import ChatTurn, IncompleteOutputError, LlmClient, LlmReply
from app.llm.prompts import (
    EXPLAIN_PROMPT_VERSION,
    EXPLAIN_SYSTEM_PROMPT,
    build_explain_task_text,
    build_explanation_correction_text,
    model_version,
)
from app.llm.schemas import EXPLANATION_SCHEMA, EXPLANATION_SCHEMA_NAME
from app.logs import get_logger
from app.messaging.cloudevents import (
    INVALID_DATA,
    LAB_EXPLANATION_FAILED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_REQUESTED,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    build_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import Publisher
from app.messaging.topology import EXPLANATION_PREFETCH, Topology
from app.validation import has_control_character, parse_date, text_length, trim

TITLE_MIN_LENGTH = 2
TITLE_MAX_LENGTH = 128
ITEMS_MIN = 1
ITEMS_MAX = 50
TEST_NAME_MAX_LENGTH = 128
VALUE_MAX_LENGTH = 64
UNIT_MAX_LENGTH = 32
REFERENCE_RANGE_MAX_LENGTH = 64

_FLAG_VALUES = frozenset(medical_record_pb2.LabResultFlag.values())
_log = get_logger("ExplanationPipeline")


# Olayın verisinin LabExplanationRequested olduğunu doğrulayıp döndürür.
def _requested(event: IncomingEvent) -> events_pb2.LabExplanationRequested:
    data = event.data
    if not isinstance(data, events_pb2.LabExplanationRequested):
        raise InvalidMessageError(INVALID_DATA)
    return data


# Kırpılmış metnin uzunluğu sınırlar içindeyse ve kontrol karakteri yoksa True verir.
def _is_single_line(value: str, min_length: int, max_length: int) -> bool:
    trimmed = trim(value)
    return min_length <= text_length(trimmed) <= max_length and not (
        has_control_character(trimmed, multiline=False)
    )


# Tek bir tahlil kaleminin alanlarını sözleşme 7.1 ve 6.6'daki sınırlarla denetler.
def _is_valid_item(item: medical_record_pb2.LabResultItem) -> bool:
    return (
        _is_single_line(item.test_name, 1, TEST_NAME_MAX_LENGTH)
        and _is_single_line(item.value, 1, VALUE_MAX_LENGTH)
        and _is_single_line(item.unit, 0, UNIT_MAX_LENGTH)
        and _is_single_line(item.reference_range, 0, REFERENCE_RANGE_MAX_LENGTH)
        and item.flag in _FLAG_VALUES
    )


# İsteğin başlık, tarih ve kalemlerini denetler; tarihleri çözülmüş olarak döndürür.
def _check_fields(
    data: events_pb2.LabExplanationRequested,
) -> tuple[date, date | None]:
    sampled_at = parse_date(data.sampled_at)
    birth_date = parse_date(data.birth_date) if data.birth_date else None
    if (
        not _is_single_line(data.title, TITLE_MIN_LENGTH, TITLE_MAX_LENGTH)
        or sampled_at is None
        or (data.birth_date and birth_date is None)
        or not ITEMS_MIN <= len(data.items) <= ITEMS_MAX
        or not all(_is_valid_item(item) for item in data.items)
    ):
        raise InvalidMessageError(INVALID_DATA)
    return sampled_at, birth_date


class ExplanationPipeline:
    # AI API istemcisini ve saati saklar, modelVersion'ı hesaplar.
    def __init__(
        self,
        llm: LlmClient,
        ai_model: str,
        *,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._llm = llm
        self._ai_model = ai_model
        self._clock = clock
        self.model_version = model_version(ai_model, EXPLAIN_PROMPT_VERSION)

    # Açıklama kuyruğunu bu akışın işleyicisi ve hata olayı üreticisiyle eşler.
    def flow(self, topology: Topology) -> Flow:
        return Flow(
            queue=topology.explanation_queue,
            event_type=LAB_EXPLANATION_REQUESTED,
            prefetch=EXPLANATION_PREFETCH,
            handle=self.handle,
            build_failure=self.build_failure,
        )

    # Onaylı tahlil değerlerini modele açıklatır ve sonucu yayınlar (sözleşme 7).
    async def handle(self, event: IncomingEvent, publisher: Publisher) -> None:
        started = time.monotonic()
        data = _requested(event)
        sampled_at, birth_date = _check_fields(data)
        task_text = build_explain_task_text(
            species=data.species,
            birth_date=birth_date,
            birth_date_estimated=data.is_birth_date_estimated,
            title=data.title,
            sampled_at=sampled_at,
            items=data.items,
        )
        result = await self._explain(data.record_id, task_text, data.items)
        generated_at = self._clock()
        await publisher.publish(
            build_event(
                events_pb2.LabExplanationGenerated(
                    record_id=data.record_id,
                    model_version=self.model_version,
                    confidence=result.confidence,
                    explanation=result.explanation,
                    generated_at=format_time(generated_at),
                ),
                LAB_EXPLANATION_GENERATED,
                now=generated_at,
            )
        )
        _log.info(
            "Tahlil açıklaması üretildi ve yayınlandı",
            extra={
                "recordId": data.record_id,
                "durationMs": elapsed_ms(started),
                "model": self._ai_model,
            },
        )

    # Verilen hata koduyla lab_explanation.failed olayını üretir.
    def build_failure(self, event: IncomingEvent, code: str) -> OutgoingEvent:
        data = _requested(event)
        failed_at = self._clock()
        return build_event(
            events_pb2.LabExplanationFailed(
                record_id=data.record_id,
                model_version=self.model_version,
                error_code=code,
                error_message=EXPLANATION_ERROR_MESSAGES[code],
                failed_at=format_time(failed_at),
            ),
            LAB_EXPLANATION_FAILED,
            now=failed_at,
        )

    # Modeli çağırır; geçersiz ya da yarım çıktıda en fazla bir kez daha dener.
    async def _explain(
        self,
        record_id: str,
        task_text: str,
        items: Sequence[medical_record_pb2.LabResultItem],
    ) -> ExplanationResult:
        follow_up: tuple[ChatTurn, ...] = ()
        try:
            first = await self._complete(task_text, follow_up)
        except IncompleteOutputError:
            _log.warning(
                "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor",
                extra={"recordId": record_id},
            )
        else:
            try:
                return validate_explanation(first.content, items)
            except ExplanationInvalid as error:
                _log.warning(
                    "Model çıktısı doğrulanamadı (%d sorun), düzeltme isteniyor",
                    len(error.issues),
                    extra={"recordId": record_id},
                )
                follow_up = (
                    ChatTurn("assistant", first.content),
                    ChatTurn("user", build_explanation_correction_text(error.issues)),
                )
        try:
            second = await self._complete(task_text, follow_up)
            return validate_explanation(second.content, items)
        except ExplanationInvalid, IncompleteOutputError:
            raise PermanentError(INVALID_AI_OUTPUT) from None

    # Açıklama talimatı, görev metni ve şemayla görselsiz tek bir model isteği gönderir.
    async def _complete(
        self, task_text: str, follow_up: Sequence[ChatTurn]
    ) -> LlmReply:
        return await self._llm.complete_json(
            system_prompt=EXPLAIN_SYSTEM_PROMPT,
            user_text=task_text,
            image_data_urls=(),
            schema_name=EXPLANATION_SCHEMA_NAME,
            schema=EXPLANATION_SCHEMA,
            follow_up=follow_up,
        )
