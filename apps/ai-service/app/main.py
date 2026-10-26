import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import ConfigError, Settings, load_settings
from app.documents.pipeline import DocumentPipeline
from app.llm.client import LlmClient, create_llm_client
from app.logs import configure_logging, get_logger
from app.messaging.consumer import Flow
from app.messaging.runtime import Messaging, start_messaging
from app.messaging.topology import Topology
from app.storage import DocumentStorage, create_storage

type MessagingStarter = Callable[[Settings, Sequence[Flow]], Awaitable[Messaging]]


# Açılış hatasından sonra AI API istemcisini kapatır, hatayı yalnızca türüyle loglar.
async def _close_llm_after_failure(llm: LlmClient, logger: logging.Logger) -> None:
    try:
        await llm.aclose()
    except Exception as error:
        logger.warning(
            "Açılış hatasından sonra AI API istemcisi kapatılamadı (%s)",
            type(error).__name__,
        )


# Ayarları, belge okuma akışını ve mesajlaşmayı lifespan içinde kuran uygulamayı kurar.
def create_app(
    settings_loader: Callable[[], Settings] = load_settings,
    messaging_starter: MessagingStarter = start_messaging,
    *,
    storage_factory: Callable[[Settings], DocumentStorage] = create_storage,
    llm_factory: Callable[[Settings], LlmClient] = create_llm_client,
) -> FastAPI:
    # Açılışta log, ayar, akış ve mesajlaşmayı kurar; kapanışta hepsini kapatır.
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging("INFO")
        try:
            settings = settings_loader()
        except ConfigError as error:
            get_logger("Bootstrap").error(str(error))
            raise
        configure_logging(settings.log_level)
        app.state.settings = settings
        logger = get_logger("Bootstrap")
        try:
            storage = storage_factory(settings)
            llm = llm_factory(settings)
        except BaseException as error:
            logger.error(
                "Dosya deposu ya da AI API istemcisi kurulamadı (%s)",
                type(error).__name__,
            )
            raise
        try:
            pipeline = DocumentPipeline(storage, llm, settings.ai_model)
            flows = [pipeline.flow(Topology())]
        except BaseException as error:
            logger.error("Belge okuma akışı kurulamadı (%s)", type(error).__name__)
            await _close_llm_after_failure(llm, logger)
            raise
        try:
            messaging = await messaging_starter(settings, flows)
        except BaseException as error:
            logger.error("RabbitMQ'ya bağlanılamadı (%s)", type(error).__name__)
            await _close_llm_after_failure(llm, logger)
            raise
        app.state.messaging = messaging
        logger.info("AI servisi başlatıldı", extra={"model": settings.ai_model})
        try:
            yield
        finally:
            logger.info("AI servisi durduruluyor")
            try:
                await messaging.stop()
            finally:
                await llm.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # Servisin ayakta olduğunu bildirir.
    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
