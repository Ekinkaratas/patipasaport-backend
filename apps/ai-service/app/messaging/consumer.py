import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial

from aio_pika.abc import (
    AbstractChannel,
    AbstractIncomingMessage,
    AbstractQueue,
    AbstractRobustConnection,
    ConsumerTag,
)

from app.errors import (
    AI_PROVIDER_UNAVAILABLE,
    INTERNAL_ERROR,
    PermanentError,
    TransientError,
)
from app.logs import correlation_scope, get_logger
from app.messaging.cloudevents import (
    IncomingEvent,
    InvalidMessageError,
    OutgoingEvent,
    parse_event,
)
from app.messaging.publisher import CHANNEL_ERRORS, UNROUTABLE, Publisher, PublishError
from app.messaging.topology import (
    CORRELATION_ID_HEADER,
    MAX_ATTEMPTS,
    RETRY_COUNT_HEADER,
    RETRY_DELAY_MS,
    Topology,
)

FlowHandler = Callable[[IncomingEvent, Publisher], Awaitable[None]]
FailureBuilder = Callable[[IncomingEvent, str], OutgoingEvent]

_log = get_logger("Consumer")
_RETRY_DELAY_SECONDS = RETRY_DELAY_MS // 1000


@dataclass(frozen=True)
class Flow:
    queue: str
    event_type: str
    prefetch: int
    handle: FlowHandler
    build_failure: FailureBuilder


@dataclass(frozen=True)
class _Subscription:
    queue_name: str
    channel: AbstractChannel
    queue: AbstractQueue
    consumer_tag: ConsumerTag


@dataclass(frozen=True)
class _Delivery:
    flow: Flow
    publisher: Publisher
    message: AbstractIncomingMessage
    event: IncomingEvent
    attempt: int
    fields: Mapping[str, object]
    started: float


# x-retry-count değerini negatif olmayan tam sayıya çevirir, geçersizse 0 verir.
def _retry_count(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if value >= 0 else 0
    if isinstance(value, float):
        return int(value) if value.is_integer() and value >= 0 else 0
    if isinstance(value, str) and value.isascii() and value.isdigit():
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


# x-correlation-id başlığı metinse onu, değilse None döndürür.
def _correlation_id(headers: Mapping[str, object]) -> str | None:
    value = headers.get(CORRELATION_ID_HEADER)
    return value if isinstance(value, str) else None


# Başlangıç anından bu yana geçen süreyi milisaniye olarak döndürür.
def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


class Consumer:
    # Tüketiciyi bağlantı, topoloji ve tüketilecek akışlarla oluşturur.
    def __init__(
        self,
        connection: AbstractRobustConnection,
        topology: Topology,
        flows: Sequence[Flow],
    ) -> None:
        self._connection = connection
        self._topology = topology
        self._flows = tuple(flows)
        self._channels: list[AbstractChannel] = []
        self._subscriptions: list[_Subscription] = []
        self._active = 0
        self._idle = asyncio.Event()
        self._idle.set()

    # Her akışa onaylı kanal açar, prefetch'i ayarlar ve kuyruğu manuel onayla tüketir.
    async def start(self) -> None:
        for flow in self._flows:
            channel = self._connection.channel(
                publisher_confirms=True, on_return_raises=True
            )
            await channel.initialize()
            self._channels.append(channel)
            await channel.set_qos(prefetch_count=flow.prefetch)
            queue = await channel.get_queue(flow.queue, ensure=True)
            publisher = Publisher(channel, self._topology)
            consumer_tag = await queue.consume(
                partial(self._on_message, flow, publisher), no_ack=False
            )
            self._subscriptions.append(
                _Subscription(flow.queue, channel, queue, consumer_tag)
            )
            _log.info("Kuyruk tüketilmeye başlandı", extra={"queue": flow.queue})

    # Tüketimi iptal eder, işlenmekte olan mesajları bekler ve kanalları kapatır.
    async def stop(self) -> None:
        subscriptions, self._subscriptions = self._subscriptions, []
        for subscription in subscriptions:
            if subscription.channel.is_closed:
                continue
            try:
                await subscription.queue.cancel(subscription.consumer_tag)
            except CHANNEL_ERRORS:
                _log.warning(
                    "Tüketim iptal edilemedi, kanal kapalı",
                    extra={"queue": subscription.queue_name},
                )
        await asyncio.sleep(0)
        await self._idle.wait()
        channels, self._channels = self._channels, []
        for channel in channels:
            try:
                await channel.close()
            except CHANNEL_ERRORS:
                _log.warning("Kanal kapatılamadı, kanal zaten kapalı")

    # Mesajı correlation id kapsamında işler ve işlenmekte olan mesajları sayar.
    async def _on_message(
        self, flow: Flow, publisher: Publisher, message: AbstractIncomingMessage
    ) -> None:
        self._active += 1
        self._idle.clear()
        try:
            with correlation_scope(_correlation_id(message.headers)):
                await self._guarded(flow, publisher, message)
        finally:
            self._active -= 1
            if self._active == 0:
                self._idle.set()

    # Mesajı işler; kuralların dışında kalan bir hata olursa mesajı DLQ'ya yollar.
    async def _guarded(
        self, flow: Flow, publisher: Publisher, message: AbstractIncomingMessage
    ) -> None:
        try:
            await self._process(flow, publisher, message)
        except Exception as error:
            fields = {"queue": flow.queue}
            _log.error(
                "Mesaj işlenirken beklenmeyen hata (%s), onaylanmamışsa DLQ'ya gider",
                type(error).__name__,
                extra=fields,
            )
            if not message.processed:
                await self._settle(partial(message.reject, requeue=False), fields)

    # Mesajı ayrıştırır, akışın işleyicisini çağırır ve sonuca göre mesajı sonlandırır.
    async def _process(
        self, flow: Flow, publisher: Publisher, message: AbstractIncomingMessage
    ) -> None:
        started = time.monotonic()
        attempt = _retry_count(message.headers.get(RETRY_COUNT_HEADER)) + 1
        base_fields: dict[str, object] = {"queue": flow.queue, "attempt": attempt}
        try:
            event = parse_event(message.body, flow.event_type)
        except InvalidMessageError as error:
            _log.error(
                "Geçersiz mesaj DLQ'ya gönderildi",
                extra={**base_fields, "errorCode": error.reason},
            )
            await self._settle(partial(message.reject, requeue=False), base_fields)
            return
        fields = {**base_fields, "eventId": event.id, "eventType": event.type}
        delivery = _Delivery(flow, publisher, message, event, attempt, fields, started)
        try:
            await flow.handle(event, publisher)
        except InvalidMessageError as error:
            _log.error(
                "İşleyici mesajı geçersiz buldu, mesaj DLQ'ya gönderildi",
                extra={**fields, "errorCode": error.reason},
            )
            await self._settle(partial(message.reject, requeue=False), fields)
        except PermanentError as error:
            await self._finish(delivery, error.code)
        except TransientError:
            await self._retry_or_finish(
                delivery, AI_PROVIDER_UNAVAILABLE, "Geçici hata"
            )
        except PublishError as error:
            if error.reason == UNROUTABLE:
                await self._retry_or_finish(
                    delivery,
                    AI_PROVIDER_UNAVAILABLE,
                    "Sonuç olayı hiçbir kuyruğa yönlendirilemedi",
                )
            else:
                _log.error(
                    "Sonuç olayı yayınlanamadı, mesaj kuyruğa geri bırakıldı",
                    extra={**fields, "errorCode": error.reason},
                )
                await self._settle(partial(message.nack, requeue=True), fields)
        except Exception as error:
            await self._retry_or_finish(
                delivery, INTERNAL_ERROR, f"Beklenmeyen hata ({type(error).__name__})"
            )
        else:
            await self._settle(message.ack, fields)
            _log.info(
                "Mesaj işlendi",
                extra={**fields, "durationMs": _elapsed_ms(started)},
            )

    # Deneme hakkı varsa tekrar kopyası yazar, yoksa kodla hata olayıyla bitirir.
    async def _retry_or_finish(
        self, delivery: _Delivery, code: str, cause: str
    ) -> None:
        if delivery.attempt < MAX_ATTEMPTS:
            await self._retry(delivery, cause)
            return
        _log.error(
            "%s, %d. denemede de sürdü",
            cause,
            delivery.attempt,
            extra={**delivery.fields, "errorCode": code},
        )
        await self._finish(delivery, code)

    # Kopyayı retry kuyruğuna yazıp asıl mesajı onaylar, yazamazsa geri bırakır.
    async def _retry(self, delivery: _Delivery, cause: str) -> None:
        message = delivery.message
        try:
            await delivery.publisher.publish_retry(
                message, delivery.flow.queue, delivery.attempt
            )
        except PublishError as error:
            _log.error(
                "Tekrar deneme kopyası yazılamadı, mesaj kuyruğa geri bırakıldı",
                extra={**delivery.fields, "errorCode": error.reason},
            )
            await self._settle(partial(message.nack, requeue=True), delivery.fields)
            return
        await self._settle(message.ack, delivery.fields)
        _log.warning(
            "%s, mesaj %d sn sonra tekrar denenecek",
            cause,
            _RETRY_DELAY_SECONDS,
            extra=delivery.fields,
        )

    # Hata olayını yayınlayıp mesajı onaylar; yönlendirilemezse tekrar dener ya da DLQ.
    async def _finish(self, delivery: _Delivery, code: str) -> None:
        message = delivery.message
        failure = delivery.flow.build_failure(delivery.event, code)
        try:
            await delivery.publisher.publish(failure)
        except PublishError as error:
            if error.reason != UNROUTABLE:
                _log.error(
                    "%s hata olayı yayınlanamadı, mesaj kuyruğa geri bırakıldı",
                    code,
                    extra={**delivery.fields, "errorCode": error.reason},
                )
                await self._settle(partial(message.nack, requeue=True), delivery.fields)
            elif delivery.attempt < MAX_ATTEMPTS:
                await self._retry(
                    delivery, f"{code} hata olayı hiçbir kuyruğa yönlendirilemedi"
                )
            else:
                _log.error(
                    "%s hata olayı hiçbir kuyruğa yönlendirilemedi, "
                    "mesaj DLQ'ya gönderildi",
                    code,
                    extra={**delivery.fields, "errorCode": error.reason},
                )
                await self._settle(
                    partial(message.reject, requeue=False), delivery.fields
                )
            return
        await self._settle(message.ack, delivery.fields)
        _log.warning(
            "Mesaj %s hata olayıyla sonuçlandı",
            code,
            extra={
                **delivery.fields,
                "errorCode": code,
                "durationMs": _elapsed_ms(delivery.started),
            },
        )

    # Onay, red ya da geri bırakmayı gönderir; kanal kapalıysa loglayıp devam eder.
    async def _settle(
        self, settle: Callable[[], Awaitable[None]], fields: Mapping[str, object]
    ) -> None:
        try:
            await settle()
        except CHANNEL_ERRORS:
            _log.error(
                "Mesajın onay bilgisi gönderilemedi, kanal kapalı; "
                "RabbitMQ mesajı yeniden teslim edecek",
                extra=fields,
            )
