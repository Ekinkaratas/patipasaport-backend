from collections.abc import Awaitable, Callable, Sequence

import aio_pika
from aio_pika.abc import AbstractRobustConnection

from app.config import Settings
from app.logs import get_logger
from app.messaging.consumer import Consumer, Flow
from app.messaging.topology import Topology, declare_topology

CONNECT_TIMEOUT_SECONDS = 10
CONNECTION_NAME = "ai-service"

_log = get_logger("Messaging")


class Messaging:
    # Çalışan RabbitMQ bağlantısını ve tüketiciyi saklar.
    def __init__(
        self, connection: AbstractRobustConnection, consumer: Consumer
    ) -> None:
        self.connection = connection
        self.consumer = consumer
        self._stopped = False

    # Önce tüketiciyi durdurur, sonra bağlantıyı kapatır; ikinci çağrıda bir şey yapmaz.
    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        try:
            await self.consumer.stop()
        finally:
            await self.connection.close()
        _log.info("RabbitMQ bağlantısı kapatıldı")


# Açılış hatasından sonra bağlantıyı kapatır, kapatma hatasını yalnızca türüyle loglar.
async def _close_after_failure(connection: AbstractRobustConnection) -> None:
    try:
        await connection.close()
    except Exception as error:
        _log.warning(
            "Açılış hatasından sonra bağlantı kapatılamadı (%s)",
            type(error).__name__,
        )


# RabbitMQ'ya bağlanır, topolojiyi tanımlar ve verilen akışlarla tüketiciyi başlatır.
async def start_messaging(
    settings: Settings,
    flows: Sequence[Flow] = (),
    *,
    connect: Callable[
        ..., Awaitable[AbstractRobustConnection]
    ] = aio_pika.connect_robust,
    topology: Topology | None = None,
) -> Messaging:
    if topology is None:
        topology = Topology()
    connection = await connect(
        host=settings.rabbitmq_host,
        port=settings.rabbitmq_port,
        login=settings.ai_rabbitmq_user,
        password=settings.ai_rabbitmq_password.get_secret_value(),
        client_properties={"connection_name": CONNECTION_NAME},
        timeout=CONNECT_TIMEOUT_SECONDS,
    )
    try:
        channel = connection.channel()
        await channel.initialize()
        await declare_topology(channel, topology)
        await channel.close()
        consumer = Consumer(connection, topology, flows)
        await consumer.start()
    except BaseException:
        await _close_after_failure(connection)
        raise
    _log.info("RabbitMQ bağlantısı kuruldu ve topoloji tanımlandı")
    return Messaging(connection, consumer)
