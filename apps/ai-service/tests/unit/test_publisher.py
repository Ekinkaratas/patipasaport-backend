import asyncio
import json
import logging
import traceback
from dataclasses import dataclass, field
from typing import Any, cast

import pytest
from aio_pika import DeliveryMode, Message
from aio_pika import exceptions as amqp_errors
from aio_pika.abc import AbstractChannel, AbstractIncomingMessage
from aiormq.abc import DeliveredMessage
from pamqp.commands import Basic
from pamqp.header import ContentHeader

from app.logs import (
    SYSTEM_CORRELATION_ID,
    UNKNOWN_CORRELATION_ID,
    JsonFormatter,
    correlation_scope,
)
from app.messaging import publisher as publisher_module
from app.messaging.cloudevents import (
    DOCUMENT_ANALYZED,
    DOCUMENT_UPLOADED,
    OutgoingEvent,
)
from app.messaging.publisher import (
    PUBLISH_FAILURE_REASONS,
    PUBLISH_TIMEOUT_SECONDS,
    Publisher,
    PublishError,
)
from app.messaging.topology import Topology

DOCUMENT_ID = "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
EVENT_ID = "5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b"
INCOMING_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
SECRET_MARKER = "GIZLI-GOVDE-7Q"
QUEUE = "ai-service.document-uploaded"
EVENT = OutgoingEvent(
    id=EVENT_ID,
    type=DOCUMENT_ANALYZED,
    subject=DOCUMENT_ID,
    body=('{"sahte":"' + SECRET_MARKER + '"}').encode(),
)
CUSTOM_TOPOLOGY = Topology(
    events_exchange="test-run.events",
    dead_letter_exchange="test-run.events.dlx",
)


@dataclass
class PublishCall:
    exchange: str
    message: Message
    routing_key: str
    mandatory: bool
    immediate: bool
    timeout: float | None


@dataclass
class FakeIncomingMessage:
    body: bytes
    headers: dict[str, Any] = field(default_factory=dict)
    content_type: str | None = "application/cloudevents+json"
    message_id: str | None = INCOMING_ID
    type: str | None = DOCUMENT_UPLOADED
    delivery_mode: DeliveryMode = DeliveryMode.PERSISTENT


class FakeExchange:
    # Sahte exchange'i ait olduğu kanal ve adıyla oluşturur.
    def __init__(self, channel: FakeChannel, name: str) -> None:
        self.channel = channel
        self.name = name

    # Yayını kaydeder; kanalda tanımlı hata varsa fırlatır, askıdaysa hiç bitmez.
    async def publish(
        self,
        message: Message,
        routing_key: str,
        *,
        mandatory: bool = True,
        immediate: bool = False,
        timeout: float | None = None,
    ) -> None:
        self.channel.calls.append(
            PublishCall(self.name, message, routing_key, mandatory, immediate, timeout)
        )
        if self.channel.error is not None:
            raise self.channel.error
        if self.channel.hang:
            await asyncio.Event().wait()


class FakeChannel:
    # Yayınları kaydeden, istenirse hata veren ya da askıda kalan sahte kanal oluşturur.
    def __init__(self, error: BaseException | None = None, hang: bool = False) -> None:
        self.error = error
        self.hang = hang
        self.calls: list[PublishCall] = []
        self.exchange_requests: list[tuple[str, bool]] = []

    # İstenen exchange'i kaydedip tanımlama yapmadan sahte exchange döndürür.
    async def get_exchange(self, name: str, *, ensure: bool = True) -> FakeExchange:
        self.exchange_requests.append((name, ensure))
        return FakeExchange(self, name)


# Gövdesinde sahte gizli değer taşıyan, yönlendirilemeyip dönen bir mesaj hatası üretir.
def returned_error() -> amqp_errors.PublishError:
    returned = DeliveredMessage(
        delivery=Basic.Return(
            reply_code=312,
            reply_text="NO_ROUTE",
            exchange="patipasaport.events",
            routing_key=DOCUMENT_ANALYZED,
        ),
        header=ContentHeader(),
        body=SECRET_MARKER.encode(),
        channel=cast(Any, None),
    )
    return amqp_errors.PublishError(returned, returned.delivery)


LIBRARY_ERRORS = [
    pytest.param(returned_error, "UNROUTABLE", id="donen-mesaj"),
    pytest.param(
        lambda: amqp_errors.DeliveryError(None, Basic.Nack(delivery_tag=1)),
        "NACK",
        id="broker-nack",
    ),
    pytest.param(TimeoutError, "TIMEOUT", id="zaman-asimi"),
    pytest.param(
        lambda: amqp_errors.ChannelInvalidStateError(SECRET_MARKER),
        "CHANNEL",
        id="kanal-acik-degil",
    ),
    pytest.param(
        lambda: amqp_errors.ChannelClosed(406, SECRET_MARKER),
        "CHANNEL",
        id="kanal-kapandi",
    ),
    pytest.param(
        lambda: amqp_errors.ConnectionClosed(320, SECRET_MARKER),
        "CHANNEL",
        id="baglanti-kapandi",
    ),
    pytest.param(ConnectionResetError, "CHANNEL", id="soket-koptu"),
]


# Sahte kanalı Publisher'ın beklediği kanal türüne çevirip yayıncı kurar.
def make_publisher(channel: FakeChannel, topology: Topology | None = None) -> Publisher:
    return Publisher(cast(AbstractChannel, channel), topology or Topology())


# Sahte gelen mesajı Publisher'ın beklediği mesaj türüne çevirir.
def incoming(message: FakeIncomingMessage) -> AbstractIncomingMessage:
    return cast(AbstractIncomingMessage, message)


# Hatanın zincirsiz olduğunu ve hiçbir yerde gizli değeri taşımadığını doğrular.
def assert_clean_error(error: PublishError, reason: str) -> None:
    assert error.reason == reason
    assert str(error) == reason
    assert error.args == (reason,)
    assert error.__cause__ is None
    assert error.__suppress_context__ is True
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error))
    assert SECRET_MARKER not in rendered
    assert SECRET_MARKER not in repr(error)


# Yayın zaman aşımının medical-record ile aynı 10 saniye olduğunu doğrular.
def test_publish_timeout_matches_medical_record() -> None:
    assert PUBLISH_TIMEOUT_SECONDS == 10


# Olayın events exchange'ine sözleşme 4.2'deki özelliklerle yayınlandığını doğrular.
async def test_publish_sends_event_with_contract_properties() -> None:
    channel = FakeChannel()

    with correlation_scope("corr-123"):
        await make_publisher(channel).publish(EVENT)

    [call] = channel.calls
    assert channel.exchange_requests == [("patipasaport.events", False)]
    assert call.exchange == "patipasaport.events"
    assert call.routing_key == "com.patipasaport.document.analyzed.v1"
    assert call.mandatory is True
    assert call.immediate is False
    assert call.timeout == 10
    message = call.message
    assert message.body == EVENT.body
    assert message.delivery_mode == DeliveryMode.PERSISTENT
    assert int(message.delivery_mode) == 2
    assert message.content_type == "application/cloudevents+json"
    assert message.message_id == EVENT_ID
    assert message.type == DOCUMENT_ANALYZED
    assert message.headers == {"x-correlation-id": "corr-123"}


# Başlıkta o anki correlation id'nin (dışarıda SYSTEM, boşsa UNKNOWN) olduğunu doğrular.
async def test_publish_writes_current_correlation_id() -> None:
    channel = FakeChannel()
    publisher = make_publisher(channel)

    await publisher.publish(EVENT)
    with correlation_scope(None):
        await publisher.publish(EVENT)
    with correlation_scope("dis"), correlation_scope("ic"):
        await publisher.publish(EVENT)

    assert [call.message.headers for call in channel.calls] == [
        {"x-correlation-id": SYSTEM_CORRELATION_ID},
        {"x-correlation-id": UNKNOWN_CORRELATION_ID},
        {"x-correlation-id": "ic"},
    ]


# Ayrı adlı topolojide olayın o topolojinin events exchange'ine gittiğini doğrular.
async def test_publish_uses_topology_events_exchange() -> None:
    channel = FakeChannel()

    await make_publisher(channel, CUSTOM_TOPOLOGY).publish(EVENT)

    assert [call.exchange for call in channel.calls] == ["test-run.events"]
    assert channel.exchange_requests == [("test-run.events", False)]


# Kopyanın DLX'e <kuyruk>.retry ile, gövde ve özellikler korunarak yazıldığını doğrular.
@pytest.mark.parametrize(
    "delivery_mode", [DeliveryMode.PERSISTENT, DeliveryMode.NOT_PERSISTENT]
)
async def test_publish_retry_copies_message_to_retry_queue(
    delivery_mode: DeliveryMode,
) -> None:
    channel = FakeChannel()
    original_headers = {
        "x-correlation-id": "corr-gelen",
        "x-retry-count": 1,
        "x-ozel": "deger",
    }
    message = FakeIncomingMessage(
        body=EVENT.body, headers=dict(original_headers), delivery_mode=delivery_mode
    )

    with correlation_scope("baska-kapsam"):
        await make_publisher(channel).publish_retry(incoming(message), QUEUE, 2)

    [call] = channel.calls
    assert channel.exchange_requests == [("patipasaport.events.dlx", False)]
    assert call.exchange == "patipasaport.events.dlx"
    assert call.routing_key == "ai-service.document-uploaded.retry"
    assert call.mandatory is True
    assert call.timeout == 10
    copy = call.message
    assert copy.body == EVENT.body
    assert copy.content_type == "application/cloudevents+json"
    assert copy.message_id == INCOMING_ID
    assert copy.type == DOCUMENT_UPLOADED
    assert copy.delivery_mode == delivery_mode
    assert copy.headers == {
        "x-correlation-id": "corr-gelen",
        "x-retry-count": 2,
        "x-ozel": "deger",
    }
    assert type(copy.headers["x-retry-count"]) is int
    assert message.headers == original_headers


# Başlıksız mesajın kopyasına yalnızca x-retry-count eklendiğini doğrular.
async def test_publish_retry_adds_retry_count_to_message_without_headers() -> None:
    channel = FakeChannel()
    message = FakeIncomingMessage(body=b"{}", content_type=None, type=None)

    await make_publisher(channel).publish_retry(incoming(message), QUEUE, 1)

    [call] = channel.calls
    assert call.message.headers == {"x-retry-count": 1}
    assert call.message.content_type is None
    assert call.message.type is None


# Ayrı adlı topolojide kopyanın o topolojinin DLX'ine ve retry adına gittiğini doğrular.
async def test_publish_retry_uses_topology_dead_letter_exchange() -> None:
    channel = FakeChannel()
    message = FakeIncomingMessage(body=b"{}")

    await make_publisher(channel, CUSTOM_TOPOLOGY).publish_retry(
        incoming(message), "test-run.documents", 3
    )

    [call] = channel.calls
    assert call.exchange == "test-run.events.dlx"
    assert call.routing_key == "test-run.documents.retry"


# Olay yayınındaki her kütüphane hatasının doğru nedene zincirsiz eşlendiğini doğrular.
@pytest.mark.parametrize(("make_error", "reason"), LIBRARY_ERRORS)
async def test_publish_maps_library_errors(make_error: Any, reason: str) -> None:
    channel = FakeChannel(error=make_error())

    with pytest.raises(PublishError) as caught:
        await make_publisher(channel).publish(EVENT)

    assert_clean_error(caught.value, reason)


# Tekrar kopyası yayınındaki her kütüphane hatasının aynı nedene eşlendiğini doğrular.
@pytest.mark.parametrize(("make_error", "reason"), LIBRARY_ERRORS)
async def test_publish_retry_maps_library_errors(make_error: Any, reason: str) -> None:
    channel = FakeChannel(error=make_error())
    message = FakeIncomingMessage(body=SECRET_MARKER.encode())

    with pytest.raises(PublishError) as caught:
        await make_publisher(channel).publish_retry(incoming(message), QUEUE, 1)

    assert_clean_error(caught.value, reason)


# Kanal hiç yanıt vermezse yayının süre dolunca TIMEOUT ile bittiğini doğrular.
async def test_publish_times_out_when_broker_never_confirms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(publisher_module, "PUBLISH_TIMEOUT_SECONDS", 0.01)
    channel = FakeChannel(hang=True)

    with pytest.raises(PublishError) as caught:
        async with asyncio.timeout(2):
            await make_publisher(channel).publish(EVENT)

    assert_clean_error(caught.value, "TIMEOUT")
    assert [call.timeout for call in channel.calls] == [0.01]


# Eşlenmeyen bir hatanın değiştirilmeden yükseldiğini doğrular.
async def test_publish_lets_unmapped_errors_propagate() -> None:
    channel = FakeChannel(error=LookupError("beklenmeyen"))

    with pytest.raises(LookupError):
        await make_publisher(channel).publish(EVENT)


# Yayın hatasının logunun Publisher bağlamında, kodla ve gövdesiz yazıldığını doğrular.
async def test_publish_failure_log_has_code_without_body(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="Publisher")
    channel = FakeChannel(error=returned_error())

    with pytest.raises(PublishError):
        await make_publisher(channel).publish(EVENT)

    [record] = [r for r in caplog.records if r.levelno >= logging.WARNING]
    payload = json.loads(JsonFormatter().format(record))
    assert record.name == "Publisher"
    assert record.exc_info is None
    assert payload["errorCode"] == "UNROUTABLE"
    assert payload["eventId"] == EVENT_ID
    assert payload["eventType"] == DOCUMENT_ANALYZED
    assert all(SECRET_MARKER not in r.getMessage() for r in caplog.records)
    assert SECRET_MARKER not in JsonFormatter().format(record)


# PublishError'ın yalnızca bilinen nedenleri kabul ettiğini doğrular.
def test_publish_error_accepts_only_known_reasons() -> None:
    assert PUBLISH_FAILURE_REASONS == {"UNROUTABLE", "NACK", "TIMEOUT", "CHANNEL"}
    for reason in PUBLISH_FAILURE_REASONS:
        error = PublishError(reason)
        assert error.reason == reason
        assert str(error) == reason
    for unknown in ("", "unroutable", SECRET_MARKER, None):
        with pytest.raises(ValueError) as caught:
            PublishError(cast(str, unknown))
        assert SECRET_MARKER not in str(caught.value)
