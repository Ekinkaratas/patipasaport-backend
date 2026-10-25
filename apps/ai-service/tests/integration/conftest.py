import asyncio
import logging
from collections.abc import AsyncIterator, Iterator

import aio_pika
import pytest
from aio_pika.abc import AbstractRobustConnection

from app.config import ConfigError, Settings, load_settings
from app.logs import JsonFormatter
from app.messaging.runtime import CONNECT_TIMEOUT_SECONDS, CONNECTION_NAME

UNREACHABLE_MESSAGE = (
    "RabbitMQ'ya bağlanılamadı ({}). Ana proje dev modunda çalışıyor olmalı ve "
    "AI RabbitMQ kullanıcısı rabbitmq-init ile oluşturulmuş olmalı."
)
CONFIGURED_LOGGER_NAMES = (
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "pydantic_settings",
    "botocore",
    "boto3",
    "urllib3",
    "httpx",
    "httpcore",
)


# Gerçek ayarları apps/ai-service/.env'den yükler; sorun varsa yalnızca adlarla düşer.
@pytest.fixture(scope="session")
def settings() -> Settings:
    try:
        return load_settings()
    except ConfigError as error:
        reason = str(error)
    pytest.fail(f"Ayarlar yüklenemedi. {reason}", pytrace=False)


# start_messaging'in parametreleriyle AI kullanıcısı adına sağlam bağlantı açar.
async def open_connection(settings: Settings) -> AbstractRobustConnection:
    try:
        return await aio_pika.connect_robust(
            host=settings.rabbitmq_host,
            port=settings.rabbitmq_port,
            login=settings.ai_rabbitmq_user,
            password=settings.ai_rabbitmq_password.get_secret_value(),
            client_properties={"connection_name": CONNECTION_NAME},
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
    except Exception as error:
        error_type = type(error).__name__
    pytest.fail(UNREACHABLE_MESSAGE.format(error_type), pytrace=False)


# Bağlanıp hemen kapatarak RabbitMQ'ya AI kullanıcısıyla ulaşılabildiğini sınar.
async def probe_broker(settings: Settings) -> None:
    connection = await open_connection(settings)
    await connection.close()


# Senkron testler için RabbitMQ'ya ulaşılabildiğini doğrular, ulaşılamazsa düşer.
@pytest.fixture
def reachable_broker(settings: Settings) -> None:
    asyncio.run(probe_broker(settings))


# Test boyunca açık kalan bir AI bağlantısı verir ve sonunda kapatır.
@pytest.fixture
async def connection(settings: Settings) -> AsyncIterator[AbstractRobustConnection]:
    opened = await open_connection(settings)
    try:
        yield opened
    finally:
        await opened.close()


# Uygulamanın kurduğu JSON log handler'larını kaldırır ve logger ayarlarını geri yükler.
@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    root_level = root.level
    saved = [
        (logger, list(logger.handlers), logger.level, logger.propagate)
        for logger in map(logging.getLogger, CONFIGURED_LOGGER_NAMES)
    ]
    yield
    for handler in [h for h in root.handlers if isinstance(h.formatter, JsonFormatter)]:
        root.removeHandler(handler)
        handler.close()
    root.setLevel(root_level)
    for logger, handlers, level, propagate in saved:
        logger.handlers[:] = handlers
        logger.setLevel(level)
        logger.propagate = propagate
