from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import ConfigError, Settings, load_settings
from app.logs import configure_logging, get_logger


# Ayarları lifespan içinde yükleyen ve /health ucunu sunan FastAPI uygulamasını kurar.
def create_app(settings_loader: Callable[[], Settings] = load_settings) -> FastAPI:
    # Açılışta logları ve ayarları kurar, kapanışta durdurulduğunu loglar.
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
        logger.info("AI servisi başlatıldı", extra={"model": settings.ai_model})
        yield
        logger.info("AI servisi durduruluyor")

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # Servisin ayakta olduğunu bildirir.
    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
