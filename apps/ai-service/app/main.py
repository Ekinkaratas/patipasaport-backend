from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import ConfigError, Settings, load_settings
from app.logs import configure_logging, get_logger
from app.messaging.runtime import Messaging, start_messaging


# Ayarları ve mesajlaşmayı lifespan içinde kuran, /health ucunu sunan uygulamayı kurar.
def create_app(
    settings_loader: Callable[[], Settings] = load_settings,
    messaging_starter: Callable[[Settings], Awaitable[Messaging]] = start_messaging,
) -> FastAPI:
    # Açılışta log, ayar ve mesajlaşmayı kurar; kapanışta mesajlaşmayı durdurur.
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
            messaging = await messaging_starter(settings)
        except Exception as error:
            logger.error("RabbitMQ'ya bağlanılamadı (%s)", type(error).__name__)
            raise
        app.state.messaging = messaging
        logger.info("AI servisi başlatıldı", extra={"model": settings.ai_model})
        try:
            yield
        finally:
            logger.info("AI servisi durduruluyor")
            await messaging.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # Servisin ayakta olduğunu bildirir.
    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
