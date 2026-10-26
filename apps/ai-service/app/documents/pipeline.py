import re
import time
from collections.abc import Callable, Sequence
from datetime import datetime

from app.clock import elapsed_ms, format_time, utc_now
from app.documents.render import SUPPORTED_MIME_TYPES, prepare_images
from app.documents.validate import (
    ExtractionInvalid,
    ExtractionResult,
    validate_extraction,
)
from app.errors import (
    ERROR_MESSAGES,
    INVALID_AI_OUTPUT,
    UNSUPPORTED_MIME_TYPE,
    PermanentError,
)
from app.generated import events_pb2
from app.llm.client import ChatTurn, IncompleteOutputError, LlmClient, LlmReply
from app.llm.prompts import (
    EXTRACT_SYSTEM_PROMPT,
    EXTRACT_TASK_TEXT,
    build_correction_text,
    model_version,
)
from app.llm.schemas import EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME
from app.logs import get_logger
from app.messaging.cloudevents import (
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_ANALYZED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    INVALID_DATA,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    build_event,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import Publisher
from app.messaging.topology import DOCUMENT_PREFETCH, Topology
from app.storage import DocumentStorage

MIN_SIZE_BYTES = 1
MAX_SIZE_BYTES = 10_485_760

_STORAGE_PATH = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"\.(?:pdf|jpg|png)"
)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_log = get_logger("DocumentPipeline")


# Olayın verisinin DocumentUploaded olduğunu doğrulayıp döndürür.
def _uploaded(event: IncomingEvent) -> events_pb2.DocumentUploaded:
    data = event.data
    if not isinstance(data, events_pb2.DocumentUploaded):
        raise InvalidMessageError(INVALID_DATA)
    return data


# Dosya anahtarını, boyutu, özeti ve türü sözleşme 6.1'e göre denetler.
def _check_fields(data: events_pb2.DocumentUploaded) -> None:
    if (
        _STORAGE_PATH.fullmatch(data.storage_path) is None
        or not MIN_SIZE_BYTES <= data.size_bytes <= MAX_SIZE_BYTES
        or _SHA256.fullmatch(data.sha256) is None
    ):
        raise InvalidMessageError(INVALID_DATA)
    if data.mime_type not in SUPPORTED_MIME_TYPES:
        raise PermanentError(UNSUPPORTED_MIME_TYPE)


class DocumentPipeline:
    # Depoyu, AI API istemcisini ve saati saklar, modelVersion'ı hesaplar.
    def __init__(
        self,
        storage: DocumentStorage,
        llm: LlmClient,
        ai_model: str,
        *,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._storage = storage
        self._llm = llm
        self._ai_model = ai_model
        self._clock = clock
        self.model_version = model_version(ai_model)

    # Belge kuyruğunu bu akışın işleyicisi ve hata olayı üreticisiyle eşler.
    def flow(self, topology: Topology) -> Flow:
        return Flow(
            queue=topology.document_queue,
            event_type=DOCUMENT_UPLOADED,
            prefetch=DOCUMENT_PREFETCH,
            handle=self.handle,
            build_failure=self.build_failure,
        )

    # Belgeyi okuyup modelden kayıt önerisi alır ve sonucu yayınlar (sözleşme 6.2).
    async def handle(self, event: IncomingEvent, publisher: Publisher) -> None:
        started = time.monotonic()
        data = _uploaded(event)
        _check_fields(data)
        started_at = self._clock()
        await publisher.publish(
            build_event(
                events_pb2.DocumentProcessingStarted(
                    document_id=data.document_id,
                    model_version=self.model_version,
                    started_at=format_time(started_at),
                ),
                DOCUMENT_PROCESSING_STARTED,
                now=started_at,
            )
        )
        content = await self._storage.read(
            data.storage_path, data.size_bytes, data.sha256
        )
        images = await prepare_images(content, data.mime_type)
        result = await self._extract(data.document_id, images, event.time)
        analyzed_at = self._clock()
        await publisher.publish(
            build_event(
                events_pb2.DocumentAnalyzed(
                    document_id=data.document_id,
                    model_version=self.model_version,
                    confidence=result.confidence,
                    proposal=result.proposal,
                    analyzed_at=format_time(analyzed_at),
                ),
                DOCUMENT_ANALYZED,
                now=analyzed_at,
            )
        )
        _log.info(
            "Belge okundu, kayıt önerisi yayınlandı",
            extra={
                "documentId": data.document_id,
                "durationMs": elapsed_ms(started),
                "model": self._ai_model,
            },
        )

    # Verilen hata koduyla analysis_failed olayını üretir.
    def build_failure(self, event: IncomingEvent, code: str) -> OutgoingEvent:
        data = _uploaded(event)
        failed_at = self._clock()
        return build_event(
            events_pb2.DocumentAnalysisFailed(
                document_id=data.document_id,
                model_version=self.model_version,
                error_code=code,
                error_message=ERROR_MESSAGES[code],
                failed_at=format_time(failed_at),
            ),
            DOCUMENT_ANALYSIS_FAILED,
            now=failed_at,
        )

    # Modeli çağırır; geçersiz ya da yarım çıktıda en fazla bir kez daha dener.
    async def _extract(
        self, document_id: str, images: Sequence[str], event_time: datetime
    ) -> ExtractionResult:
        follow_up: tuple[ChatTurn, ...] = ()
        try:
            first = await self._complete(images, follow_up)
        except IncompleteOutputError:
            _log.warning(
                "Model yanıtı yarım kaldı, istek bir kez tekrarlanıyor",
                extra={"documentId": document_id},
            )
        else:
            try:
                return validate_extraction(first.content, event_time=event_time)
            except ExtractionInvalid as error:
                _log.warning(
                    "Model çıktısı doğrulanamadı (%d sorun), düzeltme isteniyor",
                    len(error.issues),
                    extra={"documentId": document_id},
                )
                follow_up = (
                    ChatTurn("assistant", first.content),
                    ChatTurn("user", build_correction_text(error.issues)),
                )
        try:
            second = await self._complete(images, follow_up)
            return validate_extraction(second.content, event_time=event_time)
        except ExtractionInvalid, IncompleteOutputError:
            raise PermanentError(INVALID_AI_OUTPUT) from None

    # Belge okuma talimatı, görseller ve şemayla tek bir model isteği gönderir.
    async def _complete(
        self, images: Sequence[str], follow_up: Sequence[ChatTurn]
    ) -> LlmReply:
        return await self._llm.complete_json(
            system_prompt=EXTRACT_SYSTEM_PROMPT,
            user_text=EXTRACT_TASK_TEXT,
            image_data_urls=images,
            schema_name=EXTRACTION_SCHEMA_NAME,
            schema=EXTRACTION_SCHEMA,
            follow_up=follow_up,
        )
