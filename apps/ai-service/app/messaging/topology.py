from dataclasses import dataclass

from aio_pika import ExchangeType
from aio_pika.abc import AbstractChannel

from app.messaging.cloudevents import DOCUMENT_UPLOADED, LAB_EXPLANATION_REQUESTED

EVENTS_EXCHANGE = "patipasaport.events"
DEAD_LETTER_EXCHANGE = "patipasaport.events.dlx"
DOCUMENT_QUEUE = "ai-service.document-uploaded"
EXPLANATION_QUEUE = "ai-service.lab-explanation-requested"
RETRY_SUFFIX = ".retry"
DLQ_SUFFIX = ".dlq"
RETRY_DELAY_MS = 30_000
MAX_ATTEMPTS = 5
RETRY_COUNT_HEADER = "x-retry-count"
CORRELATION_ID_HEADER = "x-correlation-id"
DOCUMENT_PREFETCH = 2
EXPLANATION_PREFETCH = 4


@dataclass(frozen=True)
class Topology:
    events_exchange: str = EVENTS_EXCHANGE
    dead_letter_exchange: str = DEAD_LETTER_EXCHANGE
    document_queue: str = DOCUMENT_QUEUE
    explanation_queue: str = EXPLANATION_QUEUE

    # Kuyruğun tekrar deneme kuyruğunun adını döndürür.
    def retry_queue(self, queue: str) -> str:
        return f"{queue}{RETRY_SUFFIX}"

    # Kuyruğun son durak (DLQ) kuyruğunun adını döndürür.
    def dead_letter_queue(self, queue: str) -> str:
        return f"{queue}{DLQ_SUFFIX}"

    # Her AI kuyruğunu events exchange'inden alacağı routing key'lerle eşler.
    def bindings(self) -> dict[str, tuple[str, ...]]:
        return {
            self.document_queue: (DOCUMENT_UPLOADED,),
            self.explanation_queue: (LAB_EXPLANATION_REQUESTED,),
        }


# Mesajı DLX üzerinden verilen routing key'e yönlendiren kuyruk argümanlarını üretir.
def _dead_letter_to(topology: Topology, routing_key: str) -> dict[str, str]:
    return {
        "x-dead-letter-exchange": topology.dead_letter_exchange,
        "x-dead-letter-routing-key": routing_key,
        "x-dead-letter-strategy": "at-least-once",
        "x-overflow": "reject-publish",
    }


# Exchange'leri, AI kuyruklarını ve bağlarını sözleşmedeki argümanlarla tanımlar.
async def declare_topology(
    channel: AbstractChannel, topology: Topology | None = None
) -> None:
    if topology is None:
        topology = Topology()
    events = await channel.declare_exchange(
        topology.events_exchange, ExchangeType.TOPIC, durable=True
    )
    dead_letter = await channel.declare_exchange(
        topology.dead_letter_exchange, ExchangeType.DIRECT, durable=True
    )
    for queue_name, routing_keys in topology.bindings().items():
        retry_name = topology.retry_queue(queue_name)
        dlq_name = topology.dead_letter_queue(queue_name)
        main = await channel.declare_queue(
            queue_name,
            durable=True,
            arguments={
                "x-queue-type": "quorum",
                **_dead_letter_to(topology, dlq_name),
            },
        )
        retry = await channel.declare_queue(
            retry_name,
            durable=True,
            arguments={
                "x-queue-type": "quorum",
                "x-message-ttl": RETRY_DELAY_MS,
                **_dead_letter_to(topology, queue_name),
            },
        )
        dlq = await channel.declare_queue(
            dlq_name, durable=True, arguments={"x-queue-type": "quorum"}
        )
        for routing_key in routing_keys:
            await main.bind(events, routing_key=routing_key)
        for queue, name in ((main, queue_name), (retry, retry_name), (dlq, dlq_name)):
            await queue.bind(dead_letter, routing_key=name)
