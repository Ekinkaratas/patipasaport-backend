import asyncio
from collections.abc import Mapping

from aio_pika import DeliveryMode, Message
from aio_pika import exceptions as amqp_errors
from aio_pika.abc import AbstractChannel, AbstractIncomingMessage

from app.logs import correlation_id_var, get_logger
from app.messaging.cloudevents import CONTENT_TYPE, OutgoingEvent
from app.messaging.topology import CORRELATION_ID_HEADER, RETRY_COUNT_HEADER, Topology

PUBLISH_TIMEOUT_SECONDS = 10
UNROUTABLE = "UNROUTABLE"
NACK = "NACK"
TIMEOUT = "TIMEOUT"
CHANNEL = "CHANNEL"
PUBLISH_FAILURE_REASONS: frozenset[str] = frozenset(
    {UNROUTABLE, NACK, TIMEOUT, CHANNEL}
)
CHANNEL_ERRORS: tuple[type[Exception], ...] = (
    amqp_errors.AMQPChannelError,
    amqp_errors.AMQPConnectionError,
    amqp_errors.ChannelInvalidStateError,
    ConnectionError,
)

_log = get_logger("Publisher")


class PublishError(Exception):
    # Hatayı yalnızca sabit bir neden koduyla oluşturur, bilinmeyen nedeni reddeder.
    def __init__(self, reason: str) -> None:
        if not isinstance(reason, str) or reason not in PUBLISH_FAILURE_REASONS:
            raise ValueError("Bilinmeyen yayın hatası nedeni")
        super().__init__(reason)
        self.reason = reason

    # Hatanın metin karşılığı olarak yalnızca nedeni döndürür.
    def __str__(self) -> str:
        return self.reason


class Publisher:
    # Yayıncıyı onaylı ve dönüşte hata veren bir kanal ile topoloji üzerine kurar.
    def __init__(self, channel: AbstractChannel, topology: Topology) -> None:
        self._channel = channel
        self._topology = topology

    # Olayı events exchange'ine, routing key olay türü olacak şekilde onaylı yayınlar.
    async def publish(self, event: OutgoingEvent) -> None:
        message = Message(
            event.body,
            delivery_mode=DeliveryMode.PERSISTENT,
            content_type=CONTENT_TYPE,
            message_id=event.id,
            type=event.type,
            headers={CORRELATION_ID_HEADER: correlation_id_var.get()},
        )
        await self._send(
            self._topology.events_exchange,
            event.type,
            message,
            {"eventId": event.id, "eventType": event.type},
        )

    # Gelen mesajın kopyasını yeni x-retry-count ile DLX'ten retry kuyruğuna yazar.
    async def publish_retry(
        self, message: AbstractIncomingMessage, queue: str, retry_count: int
    ) -> None:
        copy = Message(
            message.body,
            delivery_mode=message.delivery_mode,
            content_type=message.content_type,
            message_id=message.message_id,
            type=message.type,
            headers={**message.headers, RETRY_COUNT_HEADER: retry_count},
        )
        await self._send(
            self._topology.dead_letter_exchange,
            self._topology.retry_queue(queue),
            copy,
            {"queue": queue, "attempt": retry_count},
        )

    # Mesajı var olan exchange'e onaylı yayınlar, hatayı PublishError'a çevirir.
    async def _send(
        self,
        exchange_name: str,
        routing_key: str,
        message: Message,
        fields: Mapping[str, object],
    ) -> None:
        reason: str | None = None
        try:
            async with asyncio.timeout(PUBLISH_TIMEOUT_SECONDS):
                exchange = await self._channel.get_exchange(exchange_name, ensure=False)
                await exchange.publish(
                    message,
                    routing_key=routing_key,
                    mandatory=True,
                    timeout=PUBLISH_TIMEOUT_SECONDS,
                )
        except amqp_errors.PublishError:
            reason = UNROUTABLE
        except amqp_errors.DeliveryError:
            reason = NACK
        except TimeoutError:
            reason = TIMEOUT
        except CHANNEL_ERRORS:
            reason = CHANNEL
        if reason is not None:
            _log.warning("Mesaj yayınlanamadı", extra={**fields, "errorCode": reason})
            raise PublishError(reason) from None
        _log.debug("Mesaj yayınlandı", extra=fields)
