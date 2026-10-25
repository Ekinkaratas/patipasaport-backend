import inspect
import logging
from collections.abc import Sequence
from typing import Any, cast

import aio_pika
import pytest
from aio_pika.abc import AbstractChannel, AbstractRobustConnection

from app.config import Settings
from app.errors import ERROR_MESSAGES
from app.logs import JsonFormatter
from app.messaging import runtime
from app.messaging.cloudevents import (
    DOCUMENT_UPLOADED,
    IncomingEvent,
    OutgoingEvent,
)
from app.messaging.consumer import Consumer, Flow
from app.messaging.publisher import Publisher
from app.messaging.runtime import (
    CONNECT_TIMEOUT_SECONDS,
    Messaging,
    start_messaging,
)
from app.messaging.topology import Topology

FAKE_USER = "sahte-ai-kullanicisi"
FAKE_PASSWORD = "sahte-rabbitmq-sifresi"
FAKE_HOST = "sahte-rabbitmq"
FAKE_PORT = 5673
CUSTOM_TOPOLOGY = Topology(
    events_exchange="test-run.events",
    dead_letter_exchange="test-run.events.dlx",
    document_queue="test-run.documents",
    explanation_queue="test-run.explanations",
)

type Timeline = list[str]


class TopologyError(Exception):
    pass


class ConsumerStartError(Exception):
    pass


class CloseError(Exception):
    pass


class FakeChannel:
    # Sahte kanalı ortak zaman çizelgesiyle oluşturur.
    def __init__(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.initialized = False
        self.closed = False
        self.queue_requests: list[str] = []

    # Kanalın kapatılıp kapatılmadığını döndürür.
    @property
    def is_closed(self) -> bool:
        return self.closed

    # Kanalı açılmış olarak işaretler.
    async def initialize(self, timeout: float | None = None) -> None:
        self.initialized = True
        self.timeline.append("channel.initialize")

    # Prefetch isteğini zaman çizelgesine yazar.
    async def set_qos(self, prefetch_count: int = 0, **options: Any) -> None:
        self.timeline.append("channel.set_qos")

    # Kuyruk isteğini kaydeder; boş akışlı testlerde hiç çağrılmamalıdır.
    async def get_queue(self, name: str, *, ensure: bool = True) -> Any:
        self.queue_requests.append(name)
        raise AssertionError("Kuyruk istenmemeliydi")

    # Kanalı kapatılmış olarak işaretler.
    async def close(self, exc: BaseException | None = None) -> None:
        self.closed = True
        self.timeline.append("channel.close")


class FakeConnection:
    # Açılan kanalları ve kapanışı ortak zaman çizelgesine yazan sahte bağlantı kurar.
    def __init__(
        self, timeline: Timeline, close_error: BaseException | None = None
    ) -> None:
        self.timeline = timeline
        self.close_error = close_error
        self.channels: list[FakeChannel] = []
        self.close_calls = 0

    # aio-pika gibi açılış seçenekleriyle yeni bir sahte kanal döndürür.
    def channel(
        self,
        channel_number: int | None = None,
        publisher_confirms: bool = True,
        on_return_raises: bool = False,
    ) -> FakeChannel:
        channel = FakeChannel(self.timeline)
        self.channels.append(channel)
        return channel

    # Kapanışı sayar; tanımlıysa kapatma hatasını fırlatır.
    async def close(self, exc: BaseException | None = None) -> None:
        self.close_calls += 1
        self.timeline.append("connection.close")
        if self.close_error is not None:
            raise self.close_error


class ConnectSpy:
    # Verilen bağlantıyı döndüren ya da hata veren sahte connect oluşturur.
    def __init__(
        self, connection: FakeConnection, error: BaseException | None = None
    ) -> None:
        self.connection = connection
        self.error = error
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    # Çağrı argümanlarını kaydeder ve bağlantıyı döndürür ya da hatayı fırlatır.
    async def __call__(self, *args: Any, **kwargs: Any) -> AbstractRobustConnection:
        self.calls.append((args, kwargs))
        self.connection.timeline.append("connect")
        if self.error is not None:
            raise self.error
        return cast(AbstractRobustConnection, self.connection)


class DeclareSpy:
    # Çağrıları kaydeden, istenirse hata veren sahte declare_topology oluşturur.
    def __init__(self, timeline: Timeline, error: BaseException | None = None) -> None:
        self.timeline = timeline
        self.error = error
        self.calls: list[tuple[AbstractChannel, Topology | None, bool]] = []

    # Kanalı ve topolojiyi kaydeder; tanımlıysa hatayı fırlatır.
    async def __call__(
        self, channel: AbstractChannel, topology: Topology | None = None
    ) -> None:
        fake = cast(FakeChannel, channel)
        self.calls.append((channel, topology, fake.initialized and not fake.closed))
        self.timeline.append("declare_topology")
        if self.error is not None:
            raise self.error


class FakeConsumer:
    # Sahte tüketiciyi bağlantı, topoloji, akışlar ve davranış ayarlarıyla oluşturur.
    def __init__(
        self,
        connection: AbstractRobustConnection,
        topology: Topology,
        flows: Sequence[Flow],
        *,
        timeline: Timeline,
        start_error: BaseException | None = None,
        stop_error: BaseException | None = None,
    ) -> None:
        self.connection = connection
        self.topology = topology
        self.flows = flows
        self.timeline = timeline
        self.start_error = start_error
        self.stop_error = stop_error
        self.started = False
        timeline.append("consumer.init")

    # Başlatmayı kaydeder; tanımlıysa hatayı fırlatır.
    async def start(self) -> None:
        self.timeline.append("consumer.start")
        if self.start_error is not None:
            raise self.start_error
        self.started = True

    # Durdurmayı kaydeder; tanımlıysa hatayı fırlatır.
    async def stop(self) -> None:
        self.timeline.append("consumer.stop")
        if self.stop_error is not None:
            raise self.stop_error


class ConsumerFactory:
    # Oluşturduğu sahte tüketicileri saklayan ve hata ayarlarını taşıyan fabrika kurar.
    def __init__(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.start_error: BaseException | None = None
        self.stop_error: BaseException | None = None
        self.instances: list[FakeConsumer] = []

    # runtime.Consumer yerine çağrılır ve yeni bir sahte tüketici döndürür.
    def __call__(
        self,
        connection: AbstractRobustConnection,
        topology: Topology,
        flows: Sequence[Flow],
    ) -> FakeConsumer:
        consumer = FakeConsumer(
            connection,
            topology,
            flows,
            timeline=self.timeline,
            start_error=self.start_error,
            stop_error=self.stop_error,
        )
        self.instances.append(consumer)
        return consumer


# Tüm alanları açıkça sahte değerlerle dolu, env dosyası okumayan ayarlar üretir.
def fake_settings() -> Settings:
    return Settings(
        _env_file=None,
        rabbitmq_host=FAKE_HOST,
        rabbitmq_port=FAKE_PORT,
        ai_rabbitmq_user=FAKE_USER,
        ai_rabbitmq_password=FAKE_PASSWORD,
        s3_endpoint="http://sahte-s3:8333",
        s3_bucket="sahte-bucket",
        s3_access_key="sahte-s3-erisim-anahtari",
        s3_secret_key="sahte-s3-gizli-anahtari",
        ai_api_base_url="https://sahte-ai.example/v1",
        ai_api_key="sahte-ai-api-anahtari",
        ai_model="sahte-model",
        ai_request_timeout_seconds=30.0,
        log_level="INFO",
    )


# Hiç çağrılmaması gereken sahte akış işleyicisi.
async def unused_handler(event: IncomingEvent, publisher: Publisher) -> None:
    raise AssertionError("İşleyici çağrılmamalıydı")


# Hiç çağrılmaması gereken sahte hata olayı üreticisi.
def unused_failure(event: IncomingEvent, code: str) -> OutgoingEvent:
    raise AssertionError(ERROR_MESSAGES[code])


# Belge kuyruğunu tüketen sahte bir akış üretir.
def sample_flow(queue: str = "test-run.documents") -> Flow:
    return Flow(
        queue=queue,
        event_type=DOCUMENT_UPLOADED,
        prefetch=2,
        handle=unused_handler,
        build_failure=unused_failure,
    )


# Testlerin paylaştığı zaman çizelgesini döndürür.
@pytest.fixture
def timeline() -> Timeline:
    return []


# Ortak zaman çizelgesine bağlı sahte bağlantıyı döndürür.
@pytest.fixture
def connection(timeline: Timeline) -> FakeConnection:
    return FakeConnection(timeline)


# Sahte bağlantıyı döndüren connect casusunu döndürür.
@pytest.fixture
def connect(connection: FakeConnection) -> ConnectSpy:
    return ConnectSpy(connection)


# runtime içindeki declare_topology'yi casusla değiştirir.
@pytest.fixture
def declare(monkeypatch: pytest.MonkeyPatch, timeline: Timeline) -> DeclareSpy:
    spy = DeclareSpy(timeline)
    monkeypatch.setattr(runtime, "declare_topology", spy)
    return spy


# runtime içindeki Consumer sınıfını sahte tüketici fabrikasıyla değiştirir.
@pytest.fixture
def consumers(monkeypatch: pytest.MonkeyPatch, timeline: Timeline) -> ConsumerFactory:
    factory = ConsumerFactory(timeline)
    monkeypatch.setattr(runtime, "Consumer", factory)
    return factory


# Testteki tüm logları DEBUG seviyesinden itibaren yakalar.
@pytest.fixture(autouse=True)
def capture_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)


# Kayıtların JSON biçiminde ve ham alanlarında verilen metinlerin olmadığını doğrular.
def assert_not_logged(caplog: pytest.LogCaptureFixture, *texts: str) -> None:
    formatter = JsonFormatter()
    for record in caplog.records:
        rendered = formatter.format(record) + repr(vars(record))
        for text in texts:
            assert text not in rendered


# connect'e ayardaki bilgilerin, bağlantı adının ve zaman aşımının gittiğini doğrular.
async def test_connect_receives_settings_and_timeout(
    connect: ConnectSpy, declare: DeclareSpy, consumers: ConsumerFactory
) -> None:
    await start_messaging(fake_settings(), connect=connect)

    [(args, kwargs)] = connect.calls
    assert args == ()
    assert kwargs == {
        "host": FAKE_HOST,
        "port": FAKE_PORT,
        "login": FAKE_USER,
        "password": FAKE_PASSWORD,
        "client_properties": {"connection_name": "ai-service"},
        "timeout": CONNECT_TIMEOUT_SECONDS,
    }
    assert type(kwargs["password"]) is str
    assert CONNECT_TIMEOUT_SECONDS == 10


# Varsayılan connect'in aio-pika'nın sağlam bağlantı fonksiyonu olduğunu doğrular.
def test_default_connect_is_connect_robust() -> None:
    parameter = inspect.signature(start_messaging).parameters["connect"]
    assert parameter.default is aio_pika.connect_robust
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY


# Açılış ve kapanışta şifrenin ve kullanıcı adının hiçbir loga girmediğini doğrular.
async def test_credentials_never_logged(
    caplog: pytest.LogCaptureFixture,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    messaging = await start_messaging(fake_settings(), connect=connect)
    await messaging.stop()

    assert caplog.records
    assert_not_logged(caplog, FAKE_PASSWORD, FAKE_USER)


# Hata yolunda da şifrenin ve kullanıcı adının hiçbir loga girmediğini doğrular.
async def test_credentials_never_logged_on_failure(
    caplog: pytest.LogCaptureFixture,
    timeline: Timeline,
    monkeypatch: pytest.MonkeyPatch,
    consumers: ConsumerFactory,
) -> None:
    connection = FakeConnection(timeline, close_error=CloseError(FAKE_PASSWORD))
    monkeypatch.setattr(
        runtime, "declare_topology", DeclareSpy(timeline, TopologyError(FAKE_USER))
    )

    with pytest.raises(TopologyError):
        await start_messaging(fake_settings(), connect=ConnectSpy(connection))

    assert caplog.records
    assert_not_logged(caplog, FAKE_PASSWORD, FAKE_USER)


# Topolojinin açık bir kanalda varsayılan adlarla kurulup kanalın kapandığını doğrular.
async def test_topology_is_declared_on_channel_then_channel_closed(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    await start_messaging(fake_settings(), connect=connect)

    [channel] = connection.channels
    [(declared_channel, topology, was_open)] = declare.calls
    assert declared_channel is channel
    assert topology == Topology()
    assert was_open
    assert channel.closed
    assert timeline == [
        "connect",
        "channel.initialize",
        "declare_topology",
        "channel.close",
        "consumer.init",
        "consumer.start",
    ]


# Verilen topolojinin hem tanımlamaya hem tüketiciye aynen geçtiğini doğrular.
async def test_custom_topology_is_used(
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    await start_messaging(fake_settings(), connect=connect, topology=CUSTOM_TOPOLOGY)

    [(_, topology, _)] = declare.calls
    [consumer] = consumers.instances
    assert topology is CUSTOM_TOPOLOGY
    assert consumer.topology is CUSTOM_TOPOLOGY


# Tüketicinin bağlantı ve verilen akışlarla oluşturulup başlatıldığını doğrular.
async def test_consumer_is_started_with_given_flows(
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    flows = [sample_flow("test-run.documents"), sample_flow("test-run.explanations")]

    messaging = await start_messaging(fake_settings(), flows, connect=connect)

    [consumer] = consumers.instances
    assert consumer.connection is connection
    assert list(consumer.flows) == flows
    assert consumer.started
    assert messaging.connection is connection
    assert messaging.consumer is consumer
    assert connection.close_calls == 0


# Akış verilmezse tüketicinin boş akışla başladığını doğrular.
async def test_flows_default_to_empty(
    connect: ConnectSpy, declare: DeclareSpy, consumers: ConsumerFactory
) -> None:
    await start_messaging(fake_settings(), connect=connect)

    [consumer] = consumers.instances
    assert tuple(consumer.flows) == ()


# Gerçek tüketiciyle boş akışta hiçbir kuyruğun tüketilmediğini doğrular.
async def test_empty_flows_consume_no_queue(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
) -> None:
    messaging = await start_messaging(fake_settings(), connect=connect)

    assert isinstance(messaging.consumer, Consumer)
    [channel] = connection.channels
    assert channel.closed
    assert channel.queue_requests == []
    assert "channel.set_qos" not in timeline

    await messaging.stop()

    assert connection.channels == [channel]
    assert connection.close_calls == 1


# connect hata verirse kanal açılmadığını ve hatanın aynen fırlatıldığını doğrular.
async def test_connect_failure_is_raised(
    connection: FakeConnection, declare: DeclareSpy, consumers: ConsumerFactory
) -> None:
    error = ConnectionRefusedError("bağlantı reddedildi")

    with pytest.raises(ConnectionRefusedError) as raised:
        await start_messaging(fake_settings(), connect=ConnectSpy(connection, error))

    assert raised.value is error
    assert connection.channels == []
    assert declare.calls == []
    assert consumers.instances == []


# Topoloji hatasında bağlantının kapanıp tüketicinin kurulmadığını doğrular.
async def test_topology_failure_closes_connection_and_reraises(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    monkeypatch: pytest.MonkeyPatch,
    consumers: ConsumerFactory,
) -> None:
    error = TopologyError("PRECONDITION_FAILED")
    monkeypatch.setattr(runtime, "declare_topology", DeclareSpy(timeline, error))

    with pytest.raises(TopologyError) as raised:
        await start_messaging(fake_settings(), connect=connect)

    assert raised.value is error
    assert connection.close_calls == 1
    assert consumers.instances == []
    assert timeline == [
        "connect",
        "channel.initialize",
        "declare_topology",
        "connection.close",
    ]


# Tüketici başlatılamazsa bağlantının kapandığını ve hatanın aynen fırladığını doğrular.
async def test_consumer_failure_closes_connection_and_reraises(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    error = ConsumerStartError("ACCESS_REFUSED")
    consumers.start_error = error

    with pytest.raises(ConsumerStartError) as raised:
        await start_messaging(fake_settings(), [sample_flow()], connect=connect)

    assert raised.value is error
    assert connection.close_calls == 1
    assert timeline[-2:] == ["consumer.start", "connection.close"]


# Bağlantı da kapatılamazsa asıl hatanın fırladığını ve türün loglandığını doğrular.
async def test_close_failure_after_error_keeps_original_error(
    caplog: pytest.LogCaptureFixture,
    timeline: Timeline,
    monkeypatch: pytest.MonkeyPatch,
    consumers: ConsumerFactory,
) -> None:
    connection = FakeConnection(timeline, close_error=CloseError("kapanmadı"))
    error = TopologyError("PRECONDITION_FAILED")
    monkeypatch.setattr(runtime, "declare_topology", DeclareSpy(timeline, error))

    with pytest.raises(TopologyError) as raised:
        await start_messaging(fake_settings(), connect=ConnectSpy(connection))

    assert raised.value is error
    assert connection.close_calls == 1
    [record] = [r for r in caplog.records if r.name == "Messaging"]
    assert record.levelno == logging.WARNING
    assert record.getMessage() == (
        "Açılış hatasından sonra bağlantı kapatılamadı (CloseError)"
    )
    assert record.exc_info is None
    assert "kapanmadı" not in caplog.text


# stop() önce tüketiciyi, sonra bağlantıyı kapatır; ikinci çağrı zararsızdır.
async def test_stop_order_and_second_call_is_noop(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    messaging = await start_messaging(fake_settings(), connect=connect)
    timeline.clear()

    await messaging.stop()

    assert timeline == ["consumer.stop", "connection.close"]

    await messaging.stop()

    assert timeline == ["consumer.stop", "connection.close"]
    assert connection.close_calls == 1


# Tüketici durdurulamazsa da bağlantının kapandığını ve hatanın fırladığını doğrular.
async def test_stop_closes_connection_even_if_consumer_stop_fails(
    timeline: Timeline,
    connection: FakeConnection,
    connect: ConnectSpy,
    declare: DeclareSpy,
    consumers: ConsumerFactory,
) -> None:
    consumers.stop_error = ConsumerStartError("durmadı")
    messaging = await start_messaging(fake_settings(), connect=connect)

    with pytest.raises(ConsumerStartError):
        await messaging.stop()

    assert connection.close_calls == 1
    await messaging.stop()
    assert connection.close_calls == 1


# Messaging'in kendisine verilen bağlantı ve tüketiciyi tuttuğunu doğrular.
def test_messaging_holds_connection_and_consumer(timeline: Timeline) -> None:
    connection = cast(AbstractRobustConnection, FakeConnection(timeline))
    consumer = cast(Consumer, FakeConsumer(connection, Topology(), (), timeline=[]))

    messaging = Messaging(connection, consumer)

    assert messaging.connection is connection
    assert messaging.consumer is consumer
