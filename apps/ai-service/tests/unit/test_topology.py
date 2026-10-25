from dataclasses import FrozenInstanceError, dataclass
from operator import attrgetter
from typing import Any, cast

import pytest
from aio_pika import ExchangeType
from aio_pika.abc import AbstractChannel

from app.messaging.cloudevents import (
    DOCUMENT_ANALYSIS_FAILED,
    DOCUMENT_ANALYZED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    LAB_EXPLANATION_FAILED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_REQUESTED,
)
from app.messaging.topology import (
    CORRELATION_ID_HEADER,
    DEAD_LETTER_EXCHANGE,
    DLQ_SUFFIX,
    DOCUMENT_PREFETCH,
    DOCUMENT_QUEUE,
    EVENTS_EXCHANGE,
    EXPLANATION_PREFETCH,
    EXPLANATION_QUEUE,
    MAX_ATTEMPTS,
    RETRY_COUNT_HEADER,
    RETRY_DELAY_MS,
    RETRY_SUFFIX,
    Topology,
    declare_topology,
)

PRODUCTION_NAMES = (
    "patipasaport.events",
    "patipasaport.events.dlx",
    "ai-service.document-uploaded",
    "ai-service.lab-explanation-requested",
)
MEDICAL_RECORD_QUEUES = (
    "medical-record.document-events",
    "medical-record.lab-explanation-events",
)
MEDICAL_RECORD_EVENT_TYPES = (
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_ANALYZED,
    DOCUMENT_ANALYSIS_FAILED,
    LAB_EXPLANATION_GENERATED,
    LAB_EXPLANATION_FAILED,
)
CUSTOM_TOPOLOGY = Topology(
    events_exchange="test-run.events",
    dead_letter_exchange="test-run.events.dlx",
    document_queue="test-run.documents",
    explanation_queue="test-run.explanations",
)
EXPECTED_CALL_COUNT = 2 + 6 + 8


@dataclass
class ExchangeCall:
    name: str
    type: Any
    options: dict[str, Any]


@dataclass
class QueueCall:
    name: str
    options: dict[str, Any]


@dataclass
class BindCall:
    queue: str
    exchange: str
    routing_key: str | None
    options: dict[str, Any]


type Call = ExchangeCall | QueueCall | BindCall


class FakeExchange:
    # Sahte exchange'i yalnızca adıyla oluşturur.
    def __init__(self, name: str) -> None:
        self.name = name


class FakeQueue:
    # Sahte kuyruğu adıyla ve çağrıların yazılacağı ortak listeyle oluşturur.
    def __init__(self, name: str, calls: list[Call]) -> None:
        self.name = name
        self.calls = calls

    # Bağ çağrısını kuyruk, exchange adı, routing key ve diğer seçeneklerle kaydeder.
    async def bind(
        self,
        exchange: FakeExchange | str,
        routing_key: str | None = None,
        **options: Any,
    ) -> None:
        exchange_name = exchange if isinstance(exchange, str) else exchange.name
        self.calls.append(BindCall(self.name, exchange_name, routing_key, options))


class FakeChannel:
    # Çağrıları sırasıyla kaydedecek boş bir sahte kanal oluşturur.
    def __init__(self) -> None:
        self.calls: list[Call] = []

    # Exchange tanımını kaydedip sahte exchange döndürür.
    async def declare_exchange(
        self,
        name: str,
        type: ExchangeType | str = ExchangeType.DIRECT,
        **options: Any,
    ) -> FakeExchange:
        self.calls.append(ExchangeCall(name, type, options))
        return FakeExchange(name)

    # Kuyruk tanımını kaydedip sahte kuyruk döndürür.
    async def declare_queue(self, name: str, **options: Any) -> FakeQueue:
        self.calls.append(QueueCall(name, options))
        return FakeQueue(name, self.calls)

    # Tanımlanan exchange'leri ad -> (tür, seçenekler) sözlüğü olarak döndürür.
    def exchanges(self) -> dict[str, tuple[Any, dict[str, Any]]]:
        return {
            call.name: (call.type, call.options)
            for call in self.calls
            if isinstance(call, ExchangeCall)
        }

    # Tanımlanan kuyrukları ad -> seçenekler sözlüğü olarak döndürür.
    def queues(self) -> dict[str, dict[str, Any]]:
        return {
            call.name: call.options
            for call in self.calls
            if isinstance(call, QueueCall)
        }

    # Kurulan bağları çağrı sırasıyla döndürür.
    def binds(self) -> list[BindCall]:
        return [call for call in self.calls if isinstance(call, BindCall)]


# Sözleşme 4.4'e göre ana kuyruk, retry ve dlq için beklenen tanım seçeneklerini üretir.
def expected_queues(queue: str, dead_letter_exchange: str) -> dict[str, dict[str, Any]]:
    return {
        queue: {
            "durable": True,
            "arguments": {
                "x-queue-type": "quorum",
                "x-dead-letter-exchange": dead_letter_exchange,
                "x-dead-letter-routing-key": f"{queue}.dlq",
                "x-dead-letter-strategy": "at-least-once",
                "x-overflow": "reject-publish",
            },
        },
        f"{queue}.retry": {
            "durable": True,
            "arguments": {
                "x-queue-type": "quorum",
                "x-message-ttl": 30000,
                "x-dead-letter-exchange": dead_letter_exchange,
                "x-dead-letter-routing-key": queue,
                "x-dead-letter-strategy": "at-least-once",
                "x-overflow": "reject-publish",
            },
        },
        f"{queue}.dlq": {"durable": True, "arguments": {"x-queue-type": "quorum"}},
    }


# Bir AI kuyruğu ailesinin events ve DLX exchange'lerine beklenen bağlarını üretir.
def expected_binds(
    queue: str, routing_key: str, events_exchange: str, dead_letter_exchange: str
) -> list[BindCall]:
    return [
        BindCall(queue, events_exchange, routing_key, {}),
        BindCall(queue, dead_letter_exchange, queue, {}),
        BindCall(f"{queue}.retry", dead_letter_exchange, f"{queue}.retry", {}),
        BindCall(f"{queue}.dlq", dead_letter_exchange, f"{queue}.dlq", {}),
    ]


# Bağları sıradan bağımsız karşılaştırmak için kuyruk, exchange ve key'e göre sıralar.
def sorted_binds(binds: list[BindCall]) -> list[BindCall]:
    return sorted(binds, key=attrgetter("queue", "exchange", "routing_key"))


# Kaydedilen çağrılardaki bütün metinleri iç içe yapılar dahil toplar.
def collect_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.items() for text in collect_strings(item)]
    if isinstance(value, list | tuple):
        return [text for item in value for text in collect_strings(item)]
    if isinstance(value, ExchangeCall | QueueCall | BindCall):
        return collect_strings(vars(value))
    return []


# Verilen topolojiyi sahte kanala kurup kanalı döndürür.
async def declared_channel(topology: Topology | None = None) -> FakeChannel:
    channel = FakeChannel()
    await declare_topology(cast(AbstractChannel, channel), topology)
    return channel


# Topoloji sabitlerinin sözleşme 4.4 ve 4.5'teki değerlerle aynı olduğunu doğrular.
def test_constants_match_contract() -> None:
    assert EVENTS_EXCHANGE == "patipasaport.events"
    assert DEAD_LETTER_EXCHANGE == "patipasaport.events.dlx"
    assert DOCUMENT_QUEUE == "ai-service.document-uploaded"
    assert EXPLANATION_QUEUE == "ai-service.lab-explanation-requested"
    assert RETRY_SUFFIX == ".retry"
    assert DLQ_SUFFIX == ".dlq"
    assert RETRY_DELAY_MS == 30_000
    assert type(RETRY_DELAY_MS) is int
    assert MAX_ATTEMPTS == 5
    assert RETRY_COUNT_HEADER == "x-retry-count"
    assert CORRELATION_ID_HEADER == "x-correlation-id"
    assert DOCUMENT_PREFETCH == 2
    assert EXPLANATION_PREFETCH == 4


# Varsayılan adları, türetilen retry ve dlq adlarını ve bağ eşlemesini doğrular.
def test_topology_defaults_and_derived_names() -> None:
    topology = Topology()

    assert topology.events_exchange == "patipasaport.events"
    assert topology.dead_letter_exchange == "patipasaport.events.dlx"
    assert topology.document_queue == "ai-service.document-uploaded"
    assert topology.explanation_queue == "ai-service.lab-explanation-requested"
    assert topology.retry_queue("kuyruk") == "kuyruk.retry"
    assert topology.dead_letter_queue("kuyruk") == "kuyruk.dlq"
    assert topology.bindings() == {
        "ai-service.document-uploaded": ("com.patipasaport.document.uploaded.v1",),
        "ai-service.lab-explanation-requested": (
            "com.patipasaport.lab_explanation.requested.v1",
        ),
    }
    with pytest.raises(FrozenInstanceError):
        topology.events_exchange = "baska.exchange"


# Exchange'lerin doğru türle, durable olarak ve bir kez tanımlandığını doğrular.
async def test_declares_exchanges_with_types_and_durable_flags() -> None:
    channel = await declared_channel()

    assert channel.exchanges() == {
        "patipasaport.events": (ExchangeType.TOPIC, {"durable": True}),
        "patipasaport.events.dlx": (ExchangeType.DIRECT, {"durable": True}),
    }
    assert len(channel.calls) == EXPECTED_CALL_COUNT


# Altı kuyruğun durable olarak ve argümanları birebir aynı tanımlandığını doğrular.
async def test_declares_queues_with_exact_arguments() -> None:
    channel = await declared_channel()
    queues = channel.queues()

    assert queues == {
        **expected_queues("ai-service.document-uploaded", "patipasaport.events.dlx"),
        **expected_queues(
            "ai-service.lab-explanation-requested", "patipasaport.events.dlx"
        ),
    }
    for name in (
        "ai-service.document-uploaded",
        "ai-service.lab-explanation-requested",
    ):
        assert type(queues[f"{name}.retry"]["arguments"]["x-message-ttl"]) is int
    assert len(channel.calls) == EXPECTED_CALL_COUNT


# Bütün bağların sözleşmedeki exchange ve routing key'lerle kurulduğunu doğrular.
async def test_binds_queues_to_both_exchanges() -> None:
    channel = await declared_channel()

    assert sorted_binds(channel.binds()) == sorted_binds(
        [
            *expected_binds(
                "ai-service.document-uploaded",
                "com.patipasaport.document.uploaded.v1",
                "patipasaport.events",
                "patipasaport.events.dlx",
            ),
            *expected_binds(
                "ai-service.lab-explanation-requested",
                "com.patipasaport.lab_explanation.requested.v1",
                "patipasaport.events",
                "patipasaport.events.dlx",
            ),
        ]
    )


# Exchange'lerin kuyruklardan, kuyrukların da bağlarından önce kurulduğunu doğrular.
async def test_declares_everything_before_binding() -> None:
    channel = await declared_channel()
    declared_exchanges: set[str] = set()
    declared_queues: set[str] = set()

    for call in channel.calls:
        if isinstance(call, ExchangeCall):
            assert not declared_queues
            declared_exchanges.add(call.name)
        elif isinstance(call, QueueCall):
            declared_queues.add(call.name)
        else:
            assert call.queue in declared_queues
            assert call.exchange in declared_exchanges


# Topology verilmediğinde varsayılan topolojinin kullanıldığını doğrular.
async def test_missing_topology_uses_defaults() -> None:
    implicit = await declared_channel()
    explicit = await declared_channel(Topology())

    assert implicit.calls == explicit.calls


# Ayrı adlı topolojide tüm adların değiştiğini ve üretim adı kullanılmadığını doğrular.
async def test_custom_topology_replaces_every_name() -> None:
    channel = await declared_channel(CUSTOM_TOPOLOGY)
    texts = collect_strings(channel.calls)

    assert channel.exchanges() == {
        "test-run.events": (ExchangeType.TOPIC, {"durable": True}),
        "test-run.events.dlx": (ExchangeType.DIRECT, {"durable": True}),
    }
    assert channel.queues() == {
        **expected_queues("test-run.documents", "test-run.events.dlx"),
        **expected_queues("test-run.explanations", "test-run.events.dlx"),
    }
    assert sorted_binds(channel.binds()) == sorted_binds(
        [
            *expected_binds(
                "test-run.documents",
                DOCUMENT_UPLOADED,
                "test-run.events",
                "test-run.events.dlx",
            ),
            *expected_binds(
                "test-run.explanations",
                LAB_EXPLANATION_REQUESTED,
                "test-run.events",
                "test-run.events.dlx",
            ),
        ]
    )
    assert len(channel.calls) == EXPECTED_CALL_COUNT
    for name in PRODUCTION_NAMES:
        assert not any(name in text for text in texts)


# medical-record kuyruklarının tanımlanmadığını, olaylarına bağ kurulmadığını doğrular.
async def test_never_declares_medical_record_queues() -> None:
    channel = await declared_channel()
    declared = set(channel.queues())
    routing_keys = {call.routing_key for call in channel.binds()}

    assert declared
    assert all(name.startswith("ai-service.") for name in declared)
    for queue in MEDICAL_RECORD_QUEUES:
        for name in (queue, f"{queue}.retry", f"{queue}.dlq"):
            assert name not in declared
    assert not any("medical-record" in text for text in collect_strings(channel.calls))
    assert routing_keys.isdisjoint(MEDICAL_RECORD_EVENT_TYPES)
