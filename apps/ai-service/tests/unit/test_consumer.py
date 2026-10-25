import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast

import pytest
from aio_pika import DeliveryMode, Message
from aio_pika import exceptions as amqp_errors
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from aiormq.abc import DeliveredMessage
from pamqp.commands import Basic
from pamqp.header import ContentHeader

from app.errors import (
    AI_PROVIDER_UNAVAILABLE,
    ERROR_MESSAGES,
    INTERNAL_ERROR,
    UNREADABLE_DOCUMENT,
    PermanentError,
    TransientError,
)
from app.generated import events_pb2
from app.logs import (
    SYSTEM_CORRELATION_ID,
    UNKNOWN_CORRELATION_ID,
    JsonFormatter,
    correlation_id_var,
)
from app.messaging.cloudevents import (
    CONTENT_TYPE,
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    LAB_EXPLANATION_REQUESTED,
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    build_event,
    parse_event,
)
from app.messaging.consumer import Consumer, Flow
from app.messaging.publisher import Publisher, PublishError
from app.messaging.topology import Topology

DOCUMENT_ID = "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
OTHER_DOCUMENT_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
EVENT_ID = "5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b"
RESULT_EVENT_ID = "7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
FAILURE_EVENT_ID = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"
SECRET_MARKER = "GIZLI-GOVDE-7Q"
FAKE_MODEL_VERSION = "sahte-model/extract-v1"
QUEUE = "ai-service.document-uploaded"
RETRY_ROUTING_KEY = "ai-service.document-uploaded.retry"
EVENTS_EXCHANGE = "patipasaport.events"
DEAD_LETTER_EXCHANGE = "patipasaport.events.dlx"
CORRELATION_ID = "corr-gelen-1"
CONSUMER_TAG = "etiket-ai-service.document-uploaded"
ACKED = [("ack", None)]
DEAD_LETTERED = [("reject", False)]
REQUEUED = [("nack", True)]
ALLOWED_LOG_FIELDS = frozenset(
    {"queue", "eventId", "eventType", "attempt", "errorCode", "durationMs"}
)
STANDARD_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
}

type Timeline = list[tuple[Any, ...]]


# Gövdesinde sahte gizli değer taşıyan geçerli bir document.uploaded olayı üretir.
def uploaded_body() -> bytes:
    data = events_pb2.DocumentUploaded(
        document_id=DOCUMENT_ID,
        pet_id="1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5c",
        clinic_id="6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
        storage_path=f"{SECRET_MARKER}.pdf",
        mime_type="application/pdf",
        size_bytes=123467,
        sha256="0123456789abcdef" * 4,
    )
    return build_event(data, DOCUMENT_UPLOADED, event_id=EVENT_ID).body


# Geçerli olayın subject alanını başka bir kimlikle değiştirip gövdeyi döndürür.
def mismatched_subject_body() -> bytes:
    envelope = json.loads(uploaded_body())
    envelope["subject"] = OTHER_DOCUMENT_ID
    return json.dumps(envelope).encode()


UPLOADED_BODY = uploaded_body()
RESULT_EVENT = build_event(
    events_pb2.DocumentProcessingStarted(
        document_id=DOCUMENT_ID,
        model_version=FAKE_MODEL_VERSION,
        started_at="2026-10-21T09:00:01.000Z",
    ),
    DOCUMENT_PROCESSING_STARTED,
    event_id=RESULT_EVENT_ID,
)


# Gövdesinde sahte gizli değer taşıyan, yönlendirilemeyip dönen bir mesaj hatası üretir.
def returned_error() -> BaseException:
    returned = DeliveredMessage(
        delivery=Basic.Return(
            reply_code=312,
            reply_text="NO_ROUTE",
            exchange=EVENTS_EXCHANGE,
            routing_key=DOCUMENT_ANALYSIS_FAILED,
        ),
        header=ContentHeader(),
        body=SECRET_MARKER.encode(),
        channel=cast(Any, None),
    )
    return amqp_errors.PublishError(returned, returned.delivery)


# Broker'ın yayını reddettiği (nack) bir teslim hatası üretir.
def nack_error() -> BaseException:
    return amqp_errors.DeliveryError(None, Basic.Nack(delivery_tag=1))


# Kanalın kapalı olduğunu bildiren bir kütüphane hatası üretir.
def closed_channel_error() -> BaseException:
    return amqp_errors.ChannelInvalidStateError(SECRET_MARKER)


PUBLISH_FAILURES = [
    pytest.param(returned_error, "UNROUTABLE", id="yonlendirilemedi"),
    pytest.param(nack_error, "NACK", id="nack"),
    pytest.param(TimeoutError, "TIMEOUT", id="zaman-asimi"),
    pytest.param(closed_channel_error, "CHANNEL", id="kanal-kapali"),
]
NON_UNROUTABLE_FAILURES = PUBLISH_FAILURES[1:]


@dataclass
class Published:
    channel: FakeChannel
    exchange: str
    routing_key: str
    message: Message
    mandatory: bool
    timeout: float | None


class FakeMessage:
    # Sahte gelen mesajı gövde, başlıklar ve ortak zaman çizelgesiyle oluşturur.
    def __init__(
        self,
        timeline: Timeline,
        body: bytes = UPLOADED_BODY,
        headers: dict[str, Any] | None = None,
    ) -> None:
        self.timeline = timeline
        self.body = body
        self.headers: dict[str, Any] = {} if headers is None else dict(headers)
        self.content_type: str | None = CONTENT_TYPE
        self.message_id: str | None = EVENT_ID
        self.type: str | None = DOCUMENT_UPLOADED
        self.delivery_mode = DeliveryMode.PERSISTENT
        self.processed = False
        self.settle_error: BaseException | None = None
        self.settlements: list[tuple[str, bool | None]] = []

    # Mesajı onaylar.
    async def ack(self, multiple: bool = False) -> None:
        self.settle("ack", None)

    # Mesajı verilen requeue değeriyle reddeder.
    async def reject(self, requeue: bool = False) -> None:
        self.settle("reject", requeue)

    # Mesajı verilen requeue değeriyle geri bırakır.
    async def nack(self, multiple: bool = False, requeue: bool = True) -> None:
        self.settle("nack", requeue)

    # Sonlandırmayı kaydeder; kanal kapalı senaryosunda tanımlı hatayı fırlatır.
    def settle(self, action: str, requeue: bool | None) -> None:
        if self.settle_error is not None:
            raise self.settle_error
        assert not self.processed
        self.processed = True
        self.settlements.append((action, requeue))
        self.timeline.append((action, requeue))


class FakeExchange:
    # Sahte exchange'i ait olduğu kanal ve adıyla oluşturur.
    def __init__(self, channel: FakeChannel, name: str) -> None:
        self.channel = channel
        self.name = name

    # Yayını kaydeder; bu routing key için tanımlı yayın hatası varsa fırlatır.
    async def publish(
        self,
        message: Message,
        routing_key: str,
        *,
        mandatory: bool = True,
        immediate: bool = False,
        timeout: float | None = None,
    ) -> None:
        connection = self.channel.connection
        connection.published.append(
            Published(self.channel, self.name, routing_key, message, mandatory, timeout)
        )
        connection.timeline.append(("publish", self.name, routing_key))
        make_error = connection.failures.get(routing_key)
        if make_error is not None:
            raise make_error()


class FakeQueue:
    # Sahte kuyruğu ait olduğu kanal ve adıyla oluşturur.
    def __init__(self, channel: FakeChannel, name: str) -> None:
        self.channel = channel
        self.name = name
        self.callback: Callable[[AbstractIncomingMessage], Any] | None = None
        self.no_ack: bool | None = None
        self.cancelled: list[str] = []

    # Geri çağrıyı ve onay kipini kaydedip tüketici etiketini döndürür.
    async def consume(
        self,
        callback: Callable[[AbstractIncomingMessage], Any],
        no_ack: bool = False,
        **options: Any,
    ) -> str:
        self.callback = callback
        self.no_ack = no_ack
        return f"etiket-{self.name}"

    # İptal edilen tüketici etiketini kaydeder.
    async def cancel(
        self, consumer_tag: str, timeout: float | None = None, nowait: bool = False
    ) -> None:
        self.cancelled.append(consumer_tag)
        self.channel.connection.timeline.append(("cancel", consumer_tag))

    # Kayıtlı geri çağrıyı aio-pika'nın teslim ettiği gibi mesajla çağırır.
    async def deliver(self, message: FakeMessage) -> None:
        assert self.callback is not None
        await self.callback(cast(AbstractIncomingMessage, message))


class FakeChannel:
    # Sahte kanalı bağlantısı ve açılış seçenekleriyle oluşturur.
    def __init__(
        self,
        connection: FakeConnection,
        publisher_confirms: bool,
        on_return_raises: bool,
    ) -> None:
        self.connection = connection
        self.publisher_confirms = publisher_confirms
        self.on_return_raises = on_return_raises
        self.initialized = False
        self.closed = False
        self.prefetch_counts: list[int] = []
        self.queue_requests: list[tuple[str, bool]] = []
        self.queues: dict[str, FakeQueue] = {}

    # Kanalın kapatılıp kapatılmadığını döndürür.
    @property
    def is_closed(self) -> bool:
        return self.closed

    # Kanalı açılmış olarak işaretler.
    async def initialize(self, timeout: float | None = None) -> None:
        self.initialized = True

    # İstenen prefetch değerini kaydeder.
    async def set_qos(self, prefetch_count: int = 0, **options: Any) -> None:
        self.prefetch_counts.append(prefetch_count)

    # Kuyruk isteğini kaydedip tanımlama yapmadan sahte kuyruk döndürür.
    async def get_queue(self, name: str, *, ensure: bool = True) -> FakeQueue:
        self.queue_requests.append((name, ensure))
        queue = FakeQueue(self, name)
        self.queues[name] = queue
        return queue

    # Tanımlama yapmadan istenen adla sahte exchange döndürür.
    async def get_exchange(self, name: str, *, ensure: bool = True) -> FakeExchange:
        return FakeExchange(self, name)

    # Kanalı kapatılmış olarak işaretleyip zaman çizelgesine yazar.
    async def close(self, exc: BaseException | None = None) -> None:
        self.closed = True
        self.connection.timeline.append(("close",))


class FakeConnection:
    # Açılan kanalları, yayınları ve yayın hatalarını tutan sahte bağlantı oluşturur.
    def __init__(self) -> None:
        self.channels: list[FakeChannel] = []
        self.published: list[Published] = []
        self.timeline: Timeline = []
        self.failures: dict[str, Callable[[], BaseException]] = {}

    # aio-pika gibi açılış seçenekleriyle yeni bir sahte kanal döndürür.
    def channel(
        self,
        channel_number: int | None = None,
        publisher_confirms: bool = True,
        on_return_raises: bool = False,
    ) -> FakeChannel:
        channel = FakeChannel(self, publisher_confirms, on_return_raises)
        self.channels.append(channel)
        return channel


class FakeHandler:
    # İşleyiciyi yayınlayacağı olay, fırlatacağı hata ve bekleyeceği nesnelerle kurar.
    def __init__(
        self,
        *,
        result: OutgoingEvent | None = None,
        error: BaseException | None = None,
        gate: asyncio.Event | None = None,
        barrier: asyncio.Barrier | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.gate = gate
        self.barrier = barrier
        self.calls: list[IncomingEvent] = []
        self.correlation_ids: list[str] = []
        self.publishers: list[Publisher] = []
        self.started = asyncio.Event()

    # Çağrıyı kaydeder, istenirse bekler, sonucu yayınlar ve tanımlı hatayı fırlatır.
    async def __call__(self, event: IncomingEvent, publisher: Publisher) -> None:
        self.calls.append(event)
        self.correlation_ids.append(correlation_id_var.get())
        self.publishers.append(publisher)
        self.started.set()
        if self.barrier is not None:
            await self.barrier.wait()
        if self.gate is not None:
            await self.gate.wait()
        if self.result is not None:
            await publisher.publish(self.result)
        if self.error is not None:
            raise self.error


class FailureBuilderSpy:
    # Çağrıları kaydeden, istenirse hata veren bir hata olayı üreticisi oluşturur.
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[IncomingEvent, str]] = []

    # Çağrıyı kaydeder ve verilen kodla document.analysis_failed olayını üretir.
    def __call__(self, event: IncomingEvent, code: str) -> OutgoingEvent:
        self.calls.append((event, code))
        if self.error is not None:
            raise self.error
        data = events_pb2.DocumentAnalysisFailed(
            document_id=event.subject,
            model_version=FAKE_MODEL_VERSION,
            error_code=code,
            error_message=ERROR_MESSAGES[code],
            failed_at="2026-10-21T09:00:07.000Z",
        )
        return build_event(data, DOCUMENT_ANALYSIS_FAILED, event_id=FAILURE_EVENT_ID)


@dataclass
class Harness:
    consumer: Consumer
    connection: FakeConnection
    handler: FakeHandler
    failures: FailureBuilderSpy
    queue_name: str

    # Akışın tüketilen sahte kuyruğunu döndürür.
    @property
    def queue(self) -> FakeQueue:
        return self.connection.channels[0].queues[self.queue_name]

    # Ortak zaman çizelgesine bağlı, verilen başlık ve gövdeli sahte mesaj üretir.
    def message(
        self, headers: dict[str, Any] | None = None, body: bytes = UPLOADED_BODY
    ) -> FakeMessage:
        return FakeMessage(self.connection.timeline, body=body, headers=headers)

    # Mesajı kuyruğa teslim edip işlenmesini bekler.
    async def deliver(self, message: FakeMessage) -> None:
        await self.queue.deliver(message)

    # Yapılan yayınları (exchange, routing key) çiftleri olarak döndürür.
    def routes(self) -> list[tuple[str, str]]:
        return [(item.exchange, item.routing_key) for item in self.connection.published]


# Tek belge akışlı bir tüketiciyi sahte bağlantıyla başlatır.
async def start_harness(
    handler: FakeHandler | None = None,
    failures: FailureBuilderSpy | None = None,
    *,
    prefetch: int = 2,
    topology: Topology | None = None,
) -> Harness:
    topology = topology or Topology()
    handler = handler or FakeHandler()
    failures = failures or FailureBuilderSpy()
    connection = FakeConnection()
    flow = Flow(
        queue=topology.document_queue,
        event_type=DOCUMENT_UPLOADED,
        prefetch=prefetch,
        handle=handler,
        build_failure=failures,
    )
    consumer = Consumer(cast(AbstractRobustConnection, connection), topology, [flow])
    await consumer.start()
    return Harness(consumer, connection, handler, failures, topology.document_queue)


# Mesaja verilecek x-retry-count başlığını, değer None ise başlıksız üretir.
def retry_headers(retry_count: object, **headers: Any) -> dict[str, Any]:
    if retry_count is not None:
        headers["x-retry-count"] = retry_count
    return headers


# Logger adına göre yakalanan kayıtları döndürür.
def records_of(caplog: pytest.LogCaptureFixture, name: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == name]


# Kaydın standart dışındaki (extra ile eklenen) alanlarını döndürür.
def extra_fields(record: logging.LogRecord) -> dict[str, Any]:
    return {
        name: value
        for name, value in vars(record).items()
        if name not in STANDARD_RECORD_FIELDS
    }


# Belirli bir mesaj metniyle başlayan tek Consumer kaydını döndürür.
def consumer_record(caplog: pytest.LogCaptureFixture, prefix: str) -> logging.LogRecord:
    matches = [
        record
        for record in records_of(caplog, "Consumer")
        if record.getMessage().startswith(prefix)
    ]
    assert len(matches) == 1
    return matches[0]


# Yayınlanan hata olayının gövdesindeki data nesnesini döndürür.
def published_data(published: Published) -> dict[str, Any]:
    return json.loads(published.message.body)["data"]


# Logları DEBUG seviyesinden itibaren yakalar.
@pytest.fixture(autouse=True)
def capture_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)


# Başarıda sonuç olayı onaylı yayınlandıktan sonra mesajın onaylandığını doğrular.
async def test_success_acks_after_result_is_published(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = await start_harness(FakeHandler(result=RESULT_EVENT))
    message = harness.message({"x-correlation-id": CORRELATION_ID})

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert harness.handler.calls == [parse_event(UPLOADED_BODY, DOCUMENT_UPLOADED)]
    assert all(isinstance(item, Publisher) for item in harness.handler.publishers)
    [published] = harness.connection.published
    assert published.channel is harness.connection.channels[0]
    assert harness.routes() == [(EVENTS_EXCHANGE, DOCUMENT_PROCESSING_STARTED)]
    assert published.message.headers == {"x-correlation-id": CORRELATION_ID}
    assert harness.connection.timeline == [
        ("publish", EVENTS_EXCHANGE, DOCUMENT_PROCESSING_STARTED),
        ("ack", None),
    ]
    assert harness.failures.calls == []
    record = consumer_record(caplog, "Mesaj işlendi")
    fields = extra_fields(record)
    assert record.levelno == logging.INFO
    assert set(fields) == {"queue", "eventId", "eventType", "attempt", "durationMs"}
    assert fields["queue"] == QUEUE
    assert fields["eventId"] == EVENT_ID
    assert fields["eventType"] == DOCUMENT_UPLOADED
    assert fields["attempt"] == 1
    assert isinstance(fields["durationMs"], int)
    assert fields["durationMs"] >= 0


# Geçersiz gövdenin işleyici çağrılmadan reject ile DLQ'ya gittiğini doğrular.
@pytest.mark.parametrize(
    ("body", "reason"),
    [
        pytest.param(b"json degil " + SECRET_MARKER.encode(), "NOT_JSON", id="json"),
        pytest.param(
            json.dumps([SECRET_MARKER]).encode(), "INVALID_ENVELOPE", id="zarf"
        ),
        pytest.param(RESULT_EVENT.body, "UNEXPECTED_TYPE", id="tur"),
        pytest.param(mismatched_subject_body(), "SUBJECT_MISMATCH", id="subject"),
    ],
)
async def test_invalid_body_goes_to_dlq_without_calling_handler(
    caplog: pytest.LogCaptureFixture, body: bytes, reason: str
) -> None:
    harness = await start_harness()
    message = harness.message(body=body)

    await harness.deliver(message)

    assert message.settlements == DEAD_LETTERED
    assert harness.handler.calls == []
    assert harness.connection.published == []
    assert harness.failures.calls == []
    record = consumer_record(caplog, "Geçersiz mesaj")
    assert record.levelno == logging.ERROR
    assert extra_fields(record) == {"queue": QUEUE, "attempt": 1, "errorCode": reason}


# İşleyicinin InvalidMessageError'ının olay yayınlamadan DLQ ile bittiğini doğrular.
async def test_handler_invalid_message_goes_to_dlq(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = await start_harness(
        FakeHandler(error=InvalidMessageError("INVALID_DATA"))
    )
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == DEAD_LETTERED
    assert harness.connection.published == []
    assert harness.failures.calls == []
    record = consumer_record(caplog, "İşleyici mesajı geçersiz buldu")
    assert record.levelno == logging.ERROR
    assert extra_fields(record)["errorCode"] == "INVALID_DATA"
    assert extra_fields(record)["eventId"] == EVENT_ID


# Kalıcı hatada tekrar denemeden hata olayı yayınlanıp onaylandığını doğrular.
@pytest.mark.parametrize("retry_count", [None, 2, 4])
async def test_permanent_error_publishes_failure_event_and_acks(
    caplog: pytest.LogCaptureFixture, retry_count: object
) -> None:
    harness = await start_harness(
        FakeHandler(error=PermanentError(UNREADABLE_DOCUMENT))
    )
    message = harness.message(
        retry_headers(retry_count, **{"x-correlation-id": CORRELATION_ID})
    )

    await harness.deliver(message)

    assert message.settlements == ACKED
    [(event, code)] = harness.failures.calls
    assert event == harness.handler.calls[0]
    assert code == UNREADABLE_DOCUMENT
    [published] = harness.connection.published
    assert harness.routes() == [(EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED)]
    assert published.message.message_id == FAILURE_EVENT_ID
    assert published.message.headers == {"x-correlation-id": CORRELATION_ID}
    assert published_data(published)["errorCode"] == UNREADABLE_DOCUMENT
    assert harness.connection.timeline == [
        ("publish", EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED),
        ("ack", None),
    ]
    record = consumer_record(caplog, "Mesaj UNREADABLE_DOCUMENT hata olayıyla")
    assert extra_fields(record)["errorCode"] == UNREADABLE_DOCUMENT


# 1–4. denemede geçici hatanın tekrar kopyası yazıp mesajı onayladığını doğrular.
@pytest.mark.parametrize(
    ("retry_count", "attempt"), [(None, 1), (1, 2), (2, 3), (3, 4)]
)
async def test_transient_error_before_last_attempt_publishes_retry_copy(
    caplog: pytest.LogCaptureFixture, retry_count: object, attempt: int
) -> None:
    harness = await start_harness(FakeHandler(error=TransientError(SECRET_MARKER)))
    headers = retry_headers(
        retry_count, **{"x-correlation-id": CORRELATION_ID, "x-ozel": "deger"}
    )
    message = harness.message(headers)

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert harness.failures.calls == []
    [published] = harness.connection.published
    assert harness.routes() == [(DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY)]
    assert published.mandatory is True
    copy = published.message
    assert copy.body == UPLOADED_BODY
    assert copy.content_type == CONTENT_TYPE
    assert copy.message_id == EVENT_ID
    assert copy.type == DOCUMENT_UPLOADED
    assert copy.delivery_mode == DeliveryMode.PERSISTENT
    assert copy.headers == {
        "x-correlation-id": CORRELATION_ID,
        "x-ozel": "deger",
        "x-retry-count": attempt,
    }
    assert harness.connection.timeline == [
        ("publish", DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY),
        ("ack", None),
    ]
    record = consumer_record(caplog, "Geçici hata, mesaj 30 sn sonra")
    assert record.levelno == logging.WARNING
    assert extra_fields(record)["attempt"] == attempt


# 5. ve sonraki denemede geçici hatanın AI_PROVIDER_UNAVAILABLE ile bittiğini doğrular.
@pytest.mark.parametrize("retry_count", [4, 9])
async def test_transient_error_on_last_attempt_reports_unavailable(
    caplog: pytest.LogCaptureFixture, retry_count: int
) -> None:
    harness = await start_harness(FakeHandler(error=TransientError()))
    message = harness.message(retry_headers(retry_count))

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert [code for _, code in harness.failures.calls] == [AI_PROVIDER_UNAVAILABLE]
    [published] = harness.connection.published
    assert harness.routes() == [(EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED)]
    assert published_data(published)["errorCode"] == AI_PROVIDER_UNAVAILABLE
    record = consumer_record(caplog, "Geçici hata, ")
    assert record.levelno == logging.ERROR
    assert extra_fields(record)["errorCode"] == AI_PROVIDER_UNAVAILABLE


# Beklenmeyen hatanın tekrar denendiğini, 5. denemede INTERNAL_ERROR verdiğini doğrular.
@pytest.mark.parametrize(
    ("retry_count", "expected_routes", "expected_codes"),
    [
        (None, [(DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY)], []),
        (3, [(DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY)], []),
        (4, [(EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED)], [INTERNAL_ERROR]),
    ],
)
async def test_unexpected_error_retries_then_reports_internal_error(
    caplog: pytest.LogCaptureFixture,
    retry_count: object,
    expected_routes: list[tuple[str, str]],
    expected_codes: list[str],
) -> None:
    harness = await start_harness(FakeHandler(error=KeyError(SECRET_MARKER)))
    message = harness.message(retry_headers(retry_count))

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert harness.routes() == expected_routes
    assert [code for _, code in harness.failures.calls] == expected_codes
    record = consumer_record(caplog, "Beklenmeyen hata (KeyError)")
    assert record.exc_info is None
    assert SECRET_MARKER not in record.getMessage()


# İşleyicinin yayını yönlendirilemezse geçici hata gibi işlendiğini doğrular.
@pytest.mark.parametrize(
    ("retry_count", "expected_routes", "expected_codes"),
    [
        (
            None,
            [
                (EVENTS_EXCHANGE, DOCUMENT_PROCESSING_STARTED),
                (DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY),
            ],
            [],
        ),
        (
            4,
            [
                (EVENTS_EXCHANGE, DOCUMENT_PROCESSING_STARTED),
                (EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED),
            ],
            [AI_PROVIDER_UNAVAILABLE],
        ),
    ],
)
async def test_handler_unroutable_result_is_handled_like_transient_error(
    retry_count: object,
    expected_routes: list[tuple[str, str]],
    expected_codes: list[str],
) -> None:
    harness = await start_harness(FakeHandler(result=RESULT_EVENT))
    harness.connection.failures[DOCUMENT_PROCESSING_STARTED] = returned_error
    message = harness.message(retry_headers(retry_count))

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert harness.routes() == expected_routes
    assert [code for _, code in harness.failures.calls] == expected_codes


# İşleyiciden gelen diğer PublishError türlerinde mesajın geri bırakıldığını doğrular.
@pytest.mark.parametrize("reason", ["NACK", "TIMEOUT", "CHANNEL"])
async def test_handler_other_publish_errors_requeue_message(
    caplog: pytest.LogCaptureFixture, reason: str
) -> None:
    harness = await start_harness(FakeHandler(error=PublishError(reason)))
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == REQUEUED
    assert harness.connection.published == []
    assert harness.failures.calls == []
    record = consumer_record(caplog, "Sonuç olayı yayınlanamadı")
    assert record.levelno == logging.ERROR
    assert extra_fields(record)["errorCode"] == reason


# Tekrar kopyası yazılamazsa mesajın geri bırakılıp error logu yazıldığını doğrular.
@pytest.mark.parametrize(("make_error", "reason"), PUBLISH_FAILURES)
async def test_failed_retry_publish_requeues_message(
    caplog: pytest.LogCaptureFixture,
    make_error: Callable[[], BaseException],
    reason: str,
) -> None:
    harness = await start_harness(FakeHandler(error=TransientError()))
    harness.connection.failures[RETRY_ROUTING_KEY] = make_error
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == REQUEUED
    assert harness.routes() == [(DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY)]
    record = consumer_record(caplog, "Tekrar deneme kopyası yazılamadı")
    assert record.levelno == logging.ERROR
    assert extra_fields(record)["errorCode"] == reason


# 1. denemede yönlendirilemeyen hata olayının tekrar kopyasıyla sonuçlandığını doğrular.
async def test_unroutable_failure_event_retries_on_first_attempt(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = await start_harness(
        FakeHandler(error=PermanentError(UNREADABLE_DOCUMENT))
    )
    harness.connection.failures[DOCUMENT_ANALYSIS_FAILED] = returned_error
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert harness.routes() == [
        (EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED),
        (DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY),
    ]
    assert harness.connection.published[1].message.headers == {"x-retry-count": 1}
    record = consumer_record(caplog, "UNREADABLE_DOCUMENT hata olayı hiçbir")
    assert record.levelno == logging.WARNING


# 5. denemede yönlendirilemeyen hata olayının mesajı DLQ'ya gönderdiğini doğrular.
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (PermanentError(UNREADABLE_DOCUMENT), UNREADABLE_DOCUMENT),
        (TransientError(), AI_PROVIDER_UNAVAILABLE),
    ],
)
async def test_unroutable_failure_event_on_last_attempt_goes_to_dlq(
    caplog: pytest.LogCaptureFixture, error: Exception, code: str
) -> None:
    harness = await start_harness(FakeHandler(error=error))
    harness.connection.failures[DOCUMENT_ANALYSIS_FAILED] = returned_error
    message = harness.message(retry_headers(4))

    await harness.deliver(message)

    assert message.settlements == DEAD_LETTERED
    assert harness.routes() == [(EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED)]
    assert [item for _, item in harness.failures.calls] == [code]
    record = consumer_record(caplog, f"{code} hata olayı hiçbir kuyruğa")
    assert record.levelno == logging.ERROR
    assert extra_fields(record)["errorCode"] == "UNROUTABLE"


# Hata olayı yönlendirilemez ve kopya yazılamazsa mesajın geri bırakıldığını doğrular.
async def test_unroutable_failure_event_with_failed_retry_requeues() -> None:
    harness = await start_harness(
        FakeHandler(error=PermanentError(UNREADABLE_DOCUMENT))
    )
    harness.connection.failures[DOCUMENT_ANALYSIS_FAILED] = returned_error
    harness.connection.failures[RETRY_ROUTING_KEY] = TimeoutError
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == REQUEUED
    assert harness.routes() == [
        (EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED),
        (DEAD_LETTER_EXCHANGE, RETRY_ROUTING_KEY),
    ]


# Hata olayı yayını başka bir PublishError verirse mesajın geri bırakıldığını doğrular.
@pytest.mark.parametrize(("make_error", "reason"), NON_UNROUTABLE_FAILURES)
@pytest.mark.parametrize("retry_count", [None, 4])
async def test_failure_event_publish_error_requeues_message(
    caplog: pytest.LogCaptureFixture,
    make_error: Callable[[], BaseException],
    reason: str,
    retry_count: object,
) -> None:
    harness = await start_harness(
        FakeHandler(error=PermanentError(UNREADABLE_DOCUMENT))
    )
    harness.connection.failures[DOCUMENT_ANALYSIS_FAILED] = make_error
    message = harness.message(retry_headers(retry_count))

    await harness.deliver(message)

    assert message.settlements == REQUEUED
    assert harness.routes() == [(EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED)]
    record = consumer_record(caplog, "UNREADABLE_DOCUMENT hata olayı yayınlanamadı")
    assert extra_fields(record)["errorCode"] == reason


# x-retry-count başlığının deneme sayısına çözümleme tablosunu doğrular.
@pytest.mark.parametrize(
    ("value", "attempt"),
    [
        pytest.param(None, 1, id="yok"),
        pytest.param(0, 1, id="sifir"),
        pytest.param(3, 4, id="int"),
        pytest.param(10**30, 10**30 + 1, id="buyuk-int"),
        pytest.param(3.0, 4, id="tam-float"),
        pytest.param("3", 4, id="rakam-metni"),
        pytest.param("0", 1, id="sifir-metni"),
        pytest.param(True, 1, id="bool-true"),
        pytest.param(False, 1, id="bool-false"),
        pytest.param(-2, 1, id="negatif-int"),
        pytest.param(-2.0, 1, id="negatif-float"),
        pytest.param(2.5, 1, id="kesirli-float"),
        pytest.param(float("nan"), 1, id="nan"),
        pytest.param(float("inf"), 1, id="sonsuz"),
        pytest.param("-2", 1, id="negatif-metin"),
        pytest.param(" 3", 1, id="bastaki-bosluk"),
        pytest.param("3 ", 1, id="sondaki-bosluk"),
        pytest.param("", 1, id="bos-metin"),
        pytest.param("3.0", 1, id="ondalik-metin"),
        pytest.param("uc", 1, id="harfler"),
        pytest.param(chr(0x0663), 1, id="arapca-rakam"),
        pytest.param(chr(0xFF13), 1, id="tam-genislik-rakam"),
        pytest.param("9" * 5000, 1, id="cevrilemeyecek-uzunlukta"),
        pytest.param(b"3", 1, id="bayt"),
        pytest.param(Decimal(3), 1, id="decimal"),
        pytest.param([3], 1, id="liste"),
    ],
)
async def test_retry_count_header_resolution(
    caplog: pytest.LogCaptureFixture, value: object, attempt: int
) -> None:
    harness = await start_harness()
    headers = {} if value is None else {"x-retry-count": value}
    message = harness.message(headers)

    await harness.deliver(message)

    assert message.settlements == ACKED
    assert extra_fields(consumer_record(caplog, "Mesaj işlendi"))["attempt"] == attempt


# Correlation id'nin işleyici ve yayınlara taşındığını, yoksa UNKNOWN olduğunu doğrular.
@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        pytest.param({"x-correlation-id": CORRELATION_ID}, CORRELATION_ID, id="var"),
        pytest.param({}, UNKNOWN_CORRELATION_ID, id="yok"),
        pytest.param({"x-correlation-id": ""}, UNKNOWN_CORRELATION_ID, id="bos"),
        pytest.param({"x-correlation-id": "  "}, UNKNOWN_CORRELATION_ID, id="bosluk"),
        pytest.param({"x-correlation-id": b"corr"}, UNKNOWN_CORRELATION_ID, id="bayt"),
        pytest.param({"x-correlation-id": 42}, UNKNOWN_CORRELATION_ID, id="sayi"),
    ],
)
async def test_correlation_id_reaches_handler_and_published_headers(
    headers: dict[str, Any], expected: str
) -> None:
    harness = await start_harness(
        FakeHandler(result=RESULT_EVENT, error=PermanentError(UNREADABLE_DOCUMENT))
    )
    message = harness.message(headers)

    await harness.deliver(message)

    assert harness.handler.correlation_ids == [expected]
    assert harness.routes() == [
        (EVENTS_EXCHANGE, DOCUMENT_PROCESSING_STARTED),
        (EVENTS_EXCHANGE, DOCUMENT_ANALYSIS_FAILED),
    ]
    assert [item.message.headers for item in harness.connection.published] == [
        {"x-correlation-id": expected},
        {"x-correlation-id": expected},
    ]
    assert correlation_id_var.get() == SYSTEM_CORRELATION_ID


# Loglara gövde içeriğinin, istisna mesajının ve exc_info'nun girmediğini doğrular.
async def test_logs_never_contain_body_or_exception_details(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = await start_harness(FakeHandler(result=RESULT_EVENT))
    scenarios: list[tuple[BaseException | None, dict[str, Any], bytes]] = [
        (None, {}, UPLOADED_BODY),
        (None, {}, b"json degil " + SECRET_MARKER.encode()),
        (KeyError(SECRET_MARKER), {}, UPLOADED_BODY),
        (RuntimeError(SECRET_MARKER), retry_headers(4), UPLOADED_BODY),
        (TransientError(SECRET_MARKER), {}, UPLOADED_BODY),
        (TransientError(SECRET_MARKER), retry_headers(4), UPLOADED_BODY),
        (PermanentError(UNREADABLE_DOCUMENT), {}, UPLOADED_BODY),
        (InvalidMessageError("INVALID_DATA"), {}, UPLOADED_BODY),
    ]
    harness.connection.failures[RETRY_ROUTING_KEY] = returned_error

    for error, headers, body in scenarios:
        harness.handler.error = error
        await harness.deliver(harness.message(headers, body))

    formatter = JsonFormatter()
    own_records = [
        record for record in caplog.records if record.name in {"Consumer", "Publisher"}
    ]
    assert {record.name for record in own_records} == {"Consumer", "Publisher"}
    for record in own_records:
        assert record.exc_info is None
        assert set(extra_fields(record)) <= ALLOWED_LOG_FIELDS
    for record in caplog.records:
        assert SECRET_MARKER not in formatter.format(record)


# Prefetch 2 ile iki mesajın aynı anda işleyicide bulunabildiğini doğrular.
async def test_prefetch_two_processes_two_messages_concurrently() -> None:
    harness = await start_harness(FakeHandler(barrier=asyncio.Barrier(2)), prefetch=2)
    first = harness.message()
    second = harness.message()

    async with asyncio.timeout(2):
        await asyncio.gather(harness.deliver(first), harness.deliver(second))

    assert harness.connection.channels[0].prefetch_counts == [2]
    assert len(harness.handler.calls) == 2
    assert first.settlements == ACKED
    assert second.settlements == ACKED


# stop()'un tüketimi iptal edip işlenen mesajı beklediğini, sonra kapattığını doğrular.
async def test_stop_waits_for_in_flight_message() -> None:
    gate = asyncio.Event()
    harness = await start_harness(FakeHandler(gate=gate))
    message = harness.message()
    delivery = asyncio.create_task(harness.deliver(message))
    await harness.handler.started.wait()

    stopping = asyncio.create_task(harness.consumer.stop())
    for _ in range(10):
        await asyncio.sleep(0)

    channel = harness.connection.channels[0]
    assert not stopping.done()
    assert harness.queue.cancelled == [CONSUMER_TAG]
    assert channel.closed is False
    assert message.settlements == []

    gate.set()
    async with asyncio.timeout(2):
        await stopping
        await delivery

    assert message.settlements == ACKED
    assert channel.closed is True
    assert harness.connection.timeline == [
        ("cancel", CONSUMER_TAG),
        ("ack", None),
        ("close",),
    ]


# İşlenen mesaj yokken stop()'un hemen bitip kanalı kapattığını doğrular.
async def test_stop_without_in_flight_messages_closes_channels() -> None:
    harness = await start_harness()

    async with asyncio.timeout(2):
        await harness.consumer.stop()

    assert harness.connection.timeline == [("cancel", CONSUMER_TAG), ("close",)]


# Akış listesi boşsa hiçbir kanalın açılmadığını ve kuyruğun tüketilmediğini doğrular.
async def test_empty_flow_list_consumes_nothing() -> None:
    connection = FakeConnection()
    consumer = Consumer(cast(AbstractRobustConnection, connection), Topology(), [])

    await consumer.start()
    await consumer.stop()

    assert connection.channels == []
    assert connection.timeline == []


# Her akışa onaylı ayrı kanal, prefetch ve manuel onaylı tüketim kurulduğunu doğrular.
async def test_start_opens_confirmed_channel_per_flow() -> None:
    topology = Topology()
    connection = FakeConnection()
    handler = FakeHandler(result=RESULT_EVENT)
    flows = [
        Flow(
            topology.document_queue,
            DOCUMENT_UPLOADED,
            2,
            handler,
            FailureBuilderSpy(),
        ),
        Flow(
            topology.explanation_queue,
            LAB_EXPLANATION_REQUESTED,
            4,
            FakeHandler(),
            FailureBuilderSpy(),
        ),
    ]
    consumer = Consumer(cast(AbstractRobustConnection, connection), topology, flows)

    await consumer.start()

    document_channel, explanation_channel = connection.channels
    for channel, queue, prefetch in (
        (document_channel, topology.document_queue, 2),
        (explanation_channel, topology.explanation_queue, 4),
    ):
        assert channel.publisher_confirms is True
        assert channel.on_return_raises is True
        assert channel.initialized is True
        assert channel.prefetch_counts == [prefetch]
        assert channel.queue_requests == [(queue, True)]
        assert channel.queues[queue].no_ack is False
        assert channel.queues[queue].callback is not None

    await document_channel.queues[topology.document_queue].deliver(
        FakeMessage(connection.timeline)
    )

    [published] = connection.published
    assert published.channel is document_channel


# Ayrı adlı topolojide yayınların ve tekrar kopyasının o adlara gittiğini doğrular.
async def test_custom_topology_routes_publishes_and_retries() -> None:
    topology = Topology(
        events_exchange="test-run.events",
        dead_letter_exchange="test-run.events.dlx",
        document_queue="test-run.documents",
    )
    harness = await start_harness(
        FakeHandler(result=RESULT_EVENT, error=TransientError()), topology=topology
    )

    await harness.deliver(harness.message())

    assert harness.routes() == [
        ("test-run.events", DOCUMENT_PROCESSING_STARTED),
        ("test-run.events.dlx", "test-run.documents.retry"),
    ]


# Onay sırasında kanal kapalıysa hatanın loglanıp sürecin devam ettiğini doğrular.
@pytest.mark.parametrize(
    "settle_error",
    [
        pytest.param(amqp_errors.ChannelInvalidStateError, id="kanal-acik-degil"),
        pytest.param(lambda: amqp_errors.ChannelClosed(406, "x"), id="kanal-kapandi"),
        pytest.param(
            lambda: amqp_errors.ConnectionClosed(320, "x"), id="baglanti-kapandi"
        ),
    ],
)
@pytest.mark.parametrize(
    ("error", "body"),
    [
        pytest.param(None, UPLOADED_BODY, id="ack"),
        pytest.param(None, b"json degil", id="reject"),
        pytest.param(PublishError("NACK"), UPLOADED_BODY, id="nack"),
    ],
)
async def test_closed_channel_during_settlement_is_logged(
    caplog: pytest.LogCaptureFixture,
    settle_error: Callable[[], BaseException],
    error: BaseException | None,
    body: bytes,
) -> None:
    harness = await start_harness(FakeHandler(error=error))
    message = harness.message(body=body)
    message.settle_error = settle_error()

    await harness.deliver(message)

    assert message.settlements == []
    record = consumer_record(caplog, "Mesajın onay bilgisi gönderilemedi")
    assert record.levelno == logging.ERROR


# Hata olayı üretilirken beklenmeyen hata olursa mesajın DLQ'ya gittiğini doğrular.
async def test_failure_builder_error_sends_message_to_dlq(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = await start_harness(
        FakeHandler(error=PermanentError(UNREADABLE_DOCUMENT)),
        FailureBuilderSpy(error=ValueError(SECRET_MARKER)),
    )
    message = harness.message()

    await harness.deliver(message)

    assert message.settlements == DEAD_LETTERED
    assert harness.connection.published == []
    record = consumer_record(caplog, "Mesaj işlenirken beklenmeyen hata (ValueError)")
    assert record.levelno == logging.ERROR
    assert record.exc_info is None
    assert SECRET_MARKER not in record.getMessage()
