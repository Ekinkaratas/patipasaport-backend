import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest
from aio_pika import DeliveryMode, ExchangeType, Message
from aio_pika.abc import (
    AbstractChannel,
    AbstractIncomingMessage,
    AbstractRobustConnection,
)
from aio_pika.queue import Queue
from aiormq.exceptions import ChannelAccessRefused, ChannelNotFoundEntity
from fastapi.testclient import TestClient
from google.protobuf import json_format

from app.config import Settings
from app.errors import (
    AI_PROVIDER_UNAVAILABLE,
    ERROR_MESSAGES,
    INTERNAL_ERROR,
    UNREADABLE_DOCUMENT,
    PermanentError,
    TransientError,
)
from app.generated import events_pb2
from app.main import create_app
from app.messaging.cloudevents import (
    CONTENT_TYPE,
    DATA_CONTENT_TYPE,
    DATASCHEMAS,
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    SPEC_VERSION,
    IncomingEvent,
    OutgoingEvent,
    build_event,
    parse_event,
)
from app.messaging.consumer import Consumer, Flow
from app.messaging.publisher import Publisher
from app.messaging.runtime import Messaging, start_messaging
from app.messaging.topology import (
    CORRELATION_ID_HEADER,
    DOCUMENT_PREFETCH,
    DOCUMENT_QUEUE,
    EXPLANATION_QUEUE,
    RETRY_COUNT_HEADER,
    Topology,
    declare_topology,
)

pytestmark = pytest.mark.integration

ISOLATED_PREFIX = "ai-service.it-"
MODEL_VERSION = "integration-test"
MEDICAL_RECORD_SOURCE = "/patipasaport/medical-record"
RESULT_TIMEOUT_SECONDS = 15.0
RETRY_TIMEOUT_SECONDS = 75.0
POLL_INTERVAL_SECONDS = 0.1
REQUEUE_GRACE_SECONDS = 0.5
LAST_RETRY_COUNT = 4
MIN_RETRY_GAP_SECONDS = 29.0
MAX_RETRY_GAP_SECONDS = 60.0


@dataclass(frozen=True)
class Sent:
    document_id: str
    event_id: str
    correlation_id: str
    body: bytes


# Şimdiki zamanı milisaniyeli ve Z ile biten UTC ISO-8601 metni olarak döndürür.
def now_text() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Rastgele ve çakışmayan bir ad soneki üretir.
def random_suffix() -> str:
    return uuid.uuid4().hex[:12]


# Sahte UUID v4 kimlikli, medical-record kaynaklı document.uploaded gövdesi üretir.
def uploaded_body(document_id: str, event_id: str) -> bytes:
    data = events_pb2.DocumentUploaded(
        document_id=document_id,
        pet_id=str(uuid.uuid4()),
        clinic_id=str(uuid.uuid4()),
        storage_path=f"{uuid.uuid4()}.pdf",
        mime_type="application/pdf",
        size_bytes=1024,
        sha256="0" * 64,
    )
    envelope = {
        "specversion": SPEC_VERSION,
        "id": event_id,
        "source": MEDICAL_RECORD_SOURCE,
        "type": DOCUMENT_UPLOADED,
        "subject": document_id,
        "time": now_text(),
        "datacontenttype": DATA_CONTENT_TYPE,
        "dataschema": DATASCHEMAS[DOCUMENT_UPLOADED],
        "data": json_format.MessageToDict(data),
    }
    return json.dumps(envelope).encode("utf-8")


# Verilen kodla model sürümü integration-test olan analysis_failed olayı üretir.
def build_failure(event: IncomingEvent, code: str) -> OutgoingEvent:
    data = events_pb2.DocumentAnalysisFailed(
        document_id=event.subject,
        model_version=MODEL_VERSION,
        error_code=code,
        error_message=ERROR_MESSAGES[code],
        failed_at=now_text(),
    )
    return build_event(data, DOCUMENT_ANALYSIS_FAILED)


class ScriptedHandler:
    # İşleyiciyi her çağrıda sırayla fırlatacağı hatalarla kurar.
    def __init__(self, errors: Sequence[BaseException | None] = ()) -> None:
        self._errors = list(errors)
        self.calls: list[tuple[float, IncomingEvent]] = []

    # Çağrıyı kaydeder; sıradaki hata varsa fırlatır, yoksa başlangıç olayı yayınlar.
    async def __call__(self, event: IncomingEvent, publisher: Publisher) -> None:
        index = len(self.calls)
        self.calls.append((time.monotonic(), event))
        error = self._errors[index] if index < len(self._errors) else None
        if error is not None:
            raise error
        started = events_pb2.DocumentProcessingStarted(
            document_id=event.subject,
            model_version=MODEL_VERSION,
            started_at=now_text(),
        )
        await publisher.publish(build_event(started, DOCUMENT_PROCESSING_STARTED))

    # İşleyici verilen sayıda çağrılana kadar sınırlı süre bekler, olmazsa düşer.
    async def wait_for_calls(self, count: int, timeout: float) -> None:
        try:
            async with asyncio.timeout(timeout):
                while len(self.calls) < count:
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except TimeoutError:
            pytest.fail(
                f"İşleyici {timeout:.0f} sn içinde {count} kez çağrılmadı "
                f"({len(self.calls)} çağrı)",
                pytrace=False,
            )


class IsolatedBroker:
    # Yalıtılmış adlı topoloji, yakalama kuyruğu ve tüketicilerle test ortamı kurar.
    def __init__(self, connection: AbstractRobustConnection) -> None:
        prefix = f"{ISOLATED_PREFIX}{random_suffix()}"
        self.connection = connection
        self.topology = Topology(
            events_exchange=f"{prefix}.events",
            dead_letter_exchange=f"{prefix}.dlx",
            document_queue=f"{prefix}.document-uploaded",
            explanation_queue=f"{prefix}.lab-explanation-requested",
        )
        self.capture_queue = f"{prefix}.capture"
        self.document_queues = (
            self.topology.document_queue,
            self.topology.retry_queue(self.topology.document_queue),
            self.topology.dead_letter_queue(self.topology.document_queue),
        )
        self._channel: AbstractChannel | None = None
        self._consumers: list[Consumer] = []

    # Kurulan bütün kuyrukları ve exchange'leri (tür, ad) çiftleri olarak döndürür.
    def resources(self) -> list[tuple[str, str]]:
        names: list[str] = []
        for queue in self.topology.bindings():
            names.append(queue)
            names.append(self.topology.retry_queue(queue))
            names.append(self.topology.dead_letter_queue(queue))
        names.append(self.capture_queue)
        exchanges = (self.topology.events_exchange, self.topology.dead_letter_exchange)
        return [("queue", name) for name in names] + [
            ("exchange", name) for name in exchanges
        ]

    # Testin yayın ve okuma için kullandığı kanalı döndürür.
    def channel(self) -> AbstractChannel:
        assert self._channel is not None
        return self._channel

    # İşi yeni açılan bir kanalda çalıştırır ve kanalı sonunda kapatır.
    @asynccontextmanager
    async def fresh_channel(self) -> AsyncIterator[AbstractChannel]:
        channel = self.connection.channel()
        await channel.initialize()
        try:
            yield channel
        finally:
            await channel.close()

    # Topolojiyi ve yakalama kuyruğunu kurar, kaynakların sorguda göründüğünü denetler.
    async def setup(self) -> None:
        channel = self.connection.channel()
        await channel.initialize()
        self._channel = channel
        await declare_topology(channel, self.topology)
        events = await channel.get_exchange(self.topology.events_exchange, ensure=False)
        capture = await channel.declare_queue(
            self.capture_queue, exclusive=True, robust=False
        )
        for routing_key in (DOCUMENT_PROCESSING_STARTED, DOCUMENT_ANALYSIS_FAILED):
            await capture.bind(events, routing_key=routing_key, robust=False)
        missing = [
            name for kind, name in self.resources() if not await self.exists(kind, name)
        ]
        assert missing == []

    # Belge kuyruğunu verilen işleyiciyle tek akışlı tüketiciyle tüketmeye başlar.
    async def start_consumer(self, handler: ScriptedHandler) -> None:
        flow = Flow(
            queue=self.topology.document_queue,
            event_type=DOCUMENT_UPLOADED,
            prefetch=DOCUMENT_PREFETCH,
            handle=handler,
            build_failure=build_failure,
        )
        consumer = Consumer(self.connection, self.topology, [flow])
        self._consumers.append(consumer)
        await consumer.start()

    # Çalışan tüketicileri durdurur.
    async def stop_consumers(self) -> None:
        consumers, self._consumers = self._consumers, []
        for consumer in consumers:
            await consumer.stop()

    # Yalıtılmış events exchange'ine CloudEvents biçimli document.uploaded yayınlar.
    async def publish_uploaded(
        self, *, body: bytes | None = None, retry_count: int | None = None
    ) -> Sent:
        document_id = str(uuid.uuid4())
        event_id = str(uuid.uuid4())
        correlation_id = f"it-{uuid.uuid4()}"
        payload = uploaded_body(document_id, event_id) if body is None else body
        headers: dict[str, Any] = {CORRELATION_ID_HEADER: correlation_id}
        if retry_count is not None:
            headers[RETRY_COUNT_HEADER] = retry_count
        message = Message(
            payload,
            delivery_mode=DeliveryMode.PERSISTENT,
            content_type=CONTENT_TYPE,
            message_id=event_id,
            type=DOCUMENT_UPLOADED,
            headers=headers,
        )
        exchange = await self.channel().get_exchange(
            self.topology.events_exchange, ensure=False
        )
        await exchange.publish(message, routing_key=DOCUMENT_UPLOADED, mandatory=True)
        return Sent(document_id, event_id, correlation_id, payload)

    # Kuyruktan bekleyen bir mesajı onaylayarak alır, yoksa None döndürür.
    async def poll(self, queue_name: str) -> AbstractIncomingMessage | None:
        queue = await self.channel().get_queue(queue_name, ensure=False)
        return await queue.get(no_ack=True, fail=False)

    # Kuyruktan sınırlı süre içinde bir mesaj alır, gelmezse testi düşürür.
    async def receive(
        self, queue_name: str, timeout: float = RESULT_TIMEOUT_SECONDS
    ) -> AbstractIncomingMessage:
        try:
            async with asyncio.timeout(timeout):
                while True:
                    message = await self.poll(queue_name)
                    if message is not None:
                        return message
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except TimeoutError:
            pytest.fail(
                f"{queue_name} kuyruğuna {timeout:.0f} sn içinde mesaj gelmedi",
                pytrace=False,
            )

    # Tüketicileri durdurur ve belge kuyruklarında bekleyen mesaj sayılarını döndürür.
    async def document_depths_after_stop(self) -> dict[str, int]:
        await self.stop_consumers()
        await asyncio.sleep(REQUEUE_GRACE_SECONDS)
        depths: dict[str, int] = {}
        async with self.fresh_channel() as channel:
            for name in self.document_queues:
                queue = await channel.declare_queue(name, passive=True, robust=False)
                result = queue.declaration_result
                depths[name] = result.message_count or 0
        return depths

    # Kaynağın hâlâ var olup olmadığını yeni bir kanalda pasif tanımlamayla sorgular.
    async def exists(self, kind: str, name: str) -> bool:
        async with self.fresh_channel() as channel:
            try:
                if kind == "queue":
                    await channel.declare_queue(name, passive=True, robust=False)
                else:
                    await channel.declare_exchange(name, passive=True, robust=False)
            except ChannelNotFoundEntity:
                return False
        return True

    # Tüketicileri durdurur, bütün yalıtılmış kaynakları siler ve kalanları bildirir.
    async def teardown(self) -> list[str]:
        problems: list[str] = []
        try:
            await self.stop_consumers()
        except Exception as error:
            problems.append(f"tüketici durdurulamadı ({type(error).__name__})")
        if self._channel is not None:
            try:
                await self._channel.close()
            except Exception as error:
                problems.append(f"test kanalı kapatılamadı ({type(error).__name__})")
        resources = self.resources()
        for kind, name in resources:
            if not name.startswith(ISOLATED_PREFIX):
                problems.append(f"{name} yalıtılmış önekle başlamıyor, silinmedi")
                continue
            try:
                async with self.fresh_channel() as channel:
                    if kind == "queue":
                        await channel.queue_delete(name)
                    else:
                        await channel.exchange_delete(name)
            except Exception as error:
                problems.append(f"{name} silinemedi ({type(error).__name__})")
        for kind, name in resources:
            if await self.exists(kind, name):
                problems.append(f"{name} hâlâ duruyor")
        return problems


# Yalıtılmış topolojiyi kurar; test başarısız olsa bile her şeyi siler ve doğrular.
@pytest.fixture
async def isolated(
    connection: AbstractRobustConnection,
) -> AsyncIterator[IsolatedBroker]:
    broker = IsolatedBroker(connection)
    try:
        await broker.setup()
        yield broker
    finally:
        problems = await broker.teardown()
    assert problems == []


# Mesajı parse_event ile ayrıştırır ve AMQP özelliklerinin doğru olduğunu denetler.
def parse_result(message: AbstractIncomingMessage, event_type: str) -> IncomingEvent:
    event = parse_event(message.body, event_type)
    assert message.content_type == CONTENT_TYPE
    assert message.message_id == event.id
    assert message.type == event_type
    assert message.delivery_mode == DeliveryMode.PERSISTENT
    return event


# AI kullanıcısıyla üretim adlı topolojinin çakışmadan tanımlandığını doğrular.
async def test_production_topology_declares_without_conflict(
    connection: AbstractRobustConnection,
) -> None:
    channel = connection.channel()
    await channel.initialize()
    try:
        await declare_topology(channel)
        assert not channel.is_closed
    finally:
        await channel.close()


# AI kullanıcısının medical-record adlı bir exchange tanımlayamadığını doğrular.
async def test_ai_user_cannot_declare_foreign_exchange(
    connection: AbstractRobustConnection,
) -> None:
    name = f"medical-record.it-{random_suffix()}"
    channel = connection.channel()
    await channel.initialize()
    refused = False
    try:
        await channel.declare_exchange(
            name, ExchangeType.TOPIC, durable=False, auto_delete=True, robust=False
        )
    except ChannelAccessRefused:
        refused = True
    else:
        await channel.exchange_delete(name)
    finally:
        await channel.close()

    assert refused, "AI kullanıcısı izin dışı bir exchange tanımlayabildi"


# Uygulamanın gerçek ayarlarla açılıp kapandığını, akışları kuyruğa bağlamadığını sınar.
def test_app_starts_and_stops_with_real_settings_without_consuming(
    settings: Settings,
    reachable_broker: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    consumed: list[str] = []
    offered: list[tuple[Flow, ...]] = []
    original_consume = Queue.consume

    # Tüketilmeye çalışılan kuyruğun adını kaydedip asıl consume'u çağırır.
    async def consume_spy(self: Queue, *args: Any, **kwargs: Any) -> Any:
        consumed.append(self.name)
        return await original_consume(self, *args, **kwargs)

    # Kurulan akışları kaydeder, mesajlaşmayı hiçbir akış bağlamadan başlatır.
    async def start_without_flows(
        app_settings: Settings, flows: Sequence[Flow]
    ) -> Messaging:
        offered.append(tuple(flows))
        return await start_messaging(app_settings, ())

    monkeypatch.setattr(Queue, "consume", consume_spy)
    app = create_app(messaging_starter=start_without_flows)
    try:
        with TestClient(app) as client:
            response = client.get("/health")
            messaging = app.state.messaging
    finally:
        output = capsys.readouterr().out

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert isinstance(messaging, Messaging)
    assert messaging.connection.is_closed
    [flows] = offered
    assert [flow.queue for flow in flows] == [DOCUMENT_QUEUE, EXPLANATION_QUEUE]
    assert consumed == []
    secret_values = {
        "AI_RABBITMQ_PASSWORD": settings.ai_rabbitmq_password.get_secret_value(),
        "AI_API_KEY": settings.ai_api_key.get_secret_value(),
        "S3_SECRET_KEY": settings.s3_secret_key.get_secret_value(),
    }
    leaked = [name for name, value in secret_values.items() if value in output]
    assert leaked == []


# JSON olmayan gövdenin işleyici çağrılmadan yalıtılmış DLQ'ya düştüğünü doğrular.
async def test_invalid_body_goes_to_dead_letter_queue(isolated: IsolatedBroker) -> None:
    handler = ScriptedHandler()
    await isolated.start_consumer(handler)

    sent = await isolated.publish_uploaded(body=b"bu bir JSON degil")
    dlq = isolated.topology.dead_letter_queue(isolated.topology.document_queue)
    dead = await isolated.receive(dlq)

    assert dead.body == sent.body
    assert dead.message_id == sent.event_id
    assert handler.calls == []
    assert await isolated.poll(isolated.capture_queue) is None
    assert set((await isolated.document_depths_after_stop()).values()) == {0}


# Başarıda sonuç olayının ve başlığın geldiğini, mesajın onaylandığını doğrular.
async def test_success_publishes_result_and_acks(isolated: IsolatedBroker) -> None:
    handler = ScriptedHandler()
    await isolated.start_consumer(handler)

    sent = await isolated.publish_uploaded()
    captured = await isolated.receive(isolated.capture_queue)

    event = parse_result(captured, DOCUMENT_PROCESSING_STARTED)
    assert event.subject == sent.document_id
    assert event.source == "/patipasaport/ai-service"
    assert event.data.model_version == MODEL_VERSION
    assert captured.headers[CORRELATION_ID_HEADER] == sent.correlation_id
    [(_, incoming)] = handler.calls
    assert incoming.id == sent.event_id
    assert incoming.subject == sent.document_id
    assert set((await isolated.document_depths_after_stop()).values()) == {0}


# Geçici hatada mesajın gerçek 30 sn TTL sonunda geri gelip işlendiğini doğrular.
async def test_transient_error_is_retried_after_ttl(isolated: IsolatedBroker) -> None:
    handler = ScriptedHandler([TransientError()])
    await isolated.start_consumer(handler)

    sent = await isolated.publish_uploaded()
    await handler.wait_for_calls(2, RETRY_TIMEOUT_SECONDS)
    captured = await isolated.receive(isolated.capture_queue)

    (first_at, first), (second_at, second) = handler.calls
    gap = second_at - first_at
    assert MIN_RETRY_GAP_SECONDS <= gap <= MAX_RETRY_GAP_SECONDS
    assert first.id == second.id == sent.event_id
    event = parse_result(captured, DOCUMENT_PROCESSING_STARTED)
    assert event.subject == sent.document_id
    assert captured.headers[CORRELATION_ID_HEADER] == sent.correlation_id
    assert set((await isolated.document_depths_after_stop()).values()) == {0}


FAILURE_CASES = [
    pytest.param(
        LAST_RETRY_COUNT,
        TransientError,
        AI_PROVIDER_UNAVAILABLE,
        id="besinci-denemede-gecici-hata",
    ),
    pytest.param(
        None,
        lambda: PermanentError(UNREADABLE_DOCUMENT),
        UNREADABLE_DOCUMENT,
        id="kalici-hata",
    ),
    pytest.param(
        LAST_RETRY_COUNT,
        lambda: RuntimeError("beklenmeyen"),
        INTERNAL_ERROR,
        id="besinci-denemede-beklenmeyen-hata",
    ),
]


# Hata sonucunda analysis_failed olayının doğru kodla geldiğini ve onaylandığını sınar.
@pytest.mark.parametrize(("retry_count", "make_error", "code"), FAILURE_CASES)
async def test_failure_publishes_analysis_failed_and_acks(
    isolated: IsolatedBroker,
    retry_count: int | None,
    make_error: Callable[[], BaseException],
    code: str,
) -> None:
    handler = ScriptedHandler([make_error()])
    await isolated.start_consumer(handler)

    sent = await isolated.publish_uploaded(retry_count=retry_count)
    captured = await isolated.receive(isolated.capture_queue)

    event = parse_result(captured, DOCUMENT_ANALYSIS_FAILED)
    assert event.subject == sent.document_id
    assert event.data.error_code == code
    assert event.data.error_message == ERROR_MESSAGES[code]
    assert event.data.model_version == MODEL_VERSION
    assert captured.headers[CORRELATION_ID_HEADER] == sent.correlation_id
    assert len(handler.calls) == 1
    assert set((await isolated.document_depths_after_stop()).values()) == {0}
    assert await isolated.poll(isolated.capture_queue) is None
