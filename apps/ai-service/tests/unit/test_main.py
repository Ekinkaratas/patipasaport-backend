import inspect
import json
import logging
from collections.abc import Iterator
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings, load_settings
from app.logs import JsonFormatter
from app.main import create_app
from app.messaging.runtime import Messaging, start_messaging

UVICORN_LOGGER_NAMES = ("uvicorn", "uvicorn.error", "uvicorn.access")
LIBRARY_LOGGER_NAMES = (
    "pydantic_settings",
    "botocore",
    "boto3",
    "urllib3",
    "httpx",
    "httpcore",
)
FAKE_SECRETS = (
    "sahte-rabbitmq-sifresi",
    "sahte-s3-erisim-anahtari",
    "sahte-s3-gizli-anahtari",
    "sahte-ai-api-anahtari",
)
FAKE_MODEL = "sahte-model"
CONFIG_ERROR_MESSAGE = (
    "Eksik ya da doldurulmamış ayarlar: AI_API_KEY, AI_MODEL. "
    "Geçersiz ayarlar: RABBITMQ_PORT"
)
STOPPING_MESSAGE = "AI servisi durduruluyor"


class FakeMessaging:
    # Sahte mesajlaşmayı, stop çağrısını kaydedeceği zaman çizelgesiyle oluşturur.
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline
        self.stop_calls = 0

    # Durdurma çağrısını sayar ve zaman çizelgesine yazar.
    async def stop(self) -> None:
        self.stop_calls += 1
        self.timeline.append("messaging.stop")


class StarterSpy:
    # Ayarları kaydeden, sahte mesajlaşma döndüren ya da hata veren starter kurar.
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.timeline: list[str] = []
        self.calls: list[Settings] = []
        self.started: list[FakeMessaging] = []

    # Ayarları kaydeder; tanımlıysa hatayı fırlatır, değilse sahte mesajlaşma döndürür.
    async def __call__(self, settings: Settings) -> Messaging:
        self.calls.append(settings)
        if self.error is not None:
            raise self.error
        messaging = FakeMessaging(self.timeline)
        self.started.append(messaging)
        return cast(Messaging, messaging)


class TimelineHandler(logging.Handler):
    # Bootstrap kayıtlarının mesajlarını verilen zaman çizelgesine yazan handler kurar.
    def __init__(self, timeline: list[str]) -> None:
        super().__init__()
        self.timeline = timeline

    # Kaydın mesajını zaman çizelgesine ekler.
    def emit(self, record: logging.LogRecord) -> None:
        self.timeline.append(record.getMessage())


# JSON handler'ları kaldırır ve testin değiştirdiği logger ayarlarını geri yükler.
@pytest.fixture(autouse=True)
def restore_logging(capsys: pytest.CaptureFixture[str]) -> Iterator[None]:
    root = logging.getLogger()
    root_level = root.level
    saved = [
        (logger, list(logger.handlers), logger.level, logger.propagate)
        for logger in map(logging.getLogger, UVICORN_LOGGER_NAMES)
    ]
    library_levels = [
        (logger, logger.level)
        for logger in map(logging.getLogger, LIBRARY_LOGGER_NAMES)
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
    for logger, level in library_levels:
        logger.setLevel(level)


# Tüm alanları açıkça sahte değerlerle dolu, env dosyası okumayan ayarlar üretir.
def fake_settings() -> Settings:
    return Settings(
        _env_file=None,
        rabbitmq_host="sahte-rabbitmq",
        rabbitmq_port=5672,
        ai_rabbitmq_user="sahte-ai-kullanicisi",
        ai_rabbitmq_password="sahte-rabbitmq-sifresi",
        s3_endpoint="http://sahte-s3:8333",
        s3_bucket="sahte-bucket",
        s3_access_key="sahte-s3-erisim-anahtari",
        s3_secret_key="sahte-s3-gizli-anahtari",
        ai_api_base_url="https://sahte-ai.example/v1",
        ai_api_key="sahte-ai-api-anahtari",
        ai_model=FAKE_MODEL,
        ai_request_timeout_seconds=30.0,
        log_level="INFO",
    )


# Her zaman yalnızca ayar adlarını içeren ConfigError fırlatan sahte yükleyici.
def failing_loader() -> Settings:
    raise ConfigError(CONFIG_ERROR_MESSAGE)


# Çıktının her satırını JSON nesnesi olarak okuyup liste halinde döndürür.
def parse_lines(output: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in output.splitlines() if line.strip()]


# Çıktıda sahte gizli değerlerin hiçbirinin geçmediğini doğrular.
def assert_no_secrets(output: str) -> None:
    for secret in FAKE_SECRETS:
        assert secret not in output


# /health ucunun 200 ve doğru gövde döndürdüğünü doğrular.
def test_health_returns_ok() -> None:
    with TestClient(create_app(fake_settings, StarterSpy())) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# Belgelendirme uçlarının kapalı olduğunu doğrular.
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_routes_are_disabled(path: str) -> None:
    with TestClient(create_app(fake_settings, StarterSpy())) as client:
        response = client.get(path)

    assert response.status_code == 404


# Yükleyicinin döndürdüğü ayar nesnesinin app.state'e konduğunu doğrular.
def test_state_holds_loaded_settings() -> None:
    settings = fake_settings()
    app = create_app(lambda: settings, StarterSpy())

    with TestClient(app):
        assert app.state.settings is settings


# Uygulamayı oluşturmanın yükleyiciyi ve starter'ı çağırmadığını doğrular.
def test_creating_app_does_not_load_settings() -> None:
    calls: list[int] = []
    starter = StarterSpy()

    # Çağrıldığını kaydedip sahte ayarları döndürür.
    def loader() -> Settings:
        calls.append(1)
        return fake_settings()

    app = create_app(loader, starter)
    assert calls == []
    assert starter.calls == []

    with TestClient(app):
        assert calls == [1]
        assert len(starter.calls) == 1


# Varsayılan bağımlılıkların load_settings ve start_messaging olduğunu doğrular.
def test_default_dependencies() -> None:
    parameters = inspect.signature(create_app).parameters

    assert parameters["settings_loader"].default is load_settings
    assert parameters["messaging_starter"].default is start_messaging


# Starter'a yükleyicinin döndürdüğü ayar nesnesinin aynen verildiğini doğrular.
def test_starter_receives_loaded_settings() -> None:
    settings = fake_settings()
    starter = StarterSpy()

    with TestClient(create_app(lambda: settings, starter)):
        assert starter.calls == [settings]
        assert starter.calls[0] is settings


# Starter'ın döndürdüğü mesajlaşma nesnesinin app.state'e konduğunu doğrular.
def test_state_holds_started_messaging() -> None:
    starter = StarterSpy()
    app = create_app(fake_settings, starter)

    with TestClient(app):
        [messaging] = starter.started
        assert app.state.messaging is messaging


# Kapanışta durduruluyor logundan sonra stop()'un bir kez çağrıldığını doğrular.
def test_shutdown_stops_messaging_after_stopping_log() -> None:
    starter = StarterSpy()
    bootstrap = logging.getLogger("Bootstrap")
    handler = TimelineHandler(starter.timeline)
    bootstrap.addHandler(handler)
    try:
        with TestClient(create_app(fake_settings, starter)):
            [messaging] = starter.started
            assert messaging.stop_calls == 0
    finally:
        bootstrap.removeHandler(handler)

    assert messaging.stop_calls == 1
    assert starter.timeline[-2:] == [STOPPING_MESSAGE, "messaging.stop"]


# Ayar hatasında açılışın durduğunu ve error logunda yalnızca adlar olduğunu doğrular.
def test_config_error_stops_startup_and_logs_names_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    starter = StarterSpy()

    with pytest.raises(ConfigError), TestClient(create_app(failing_loader, starter)):
        pass

    output = capsys.readouterr().out
    errors = [r for r in parse_lines(output) if r["level"] == "error"]

    assert len(errors) == 1
    [record] = errors
    assert record["context"] == "Bootstrap"
    assert record["message"] == CONFIG_ERROR_MESSAGE
    for name in ("AI_API_KEY", "AI_MODEL", "RABBITMQ_PORT"):
        assert name in record["message"]
    assert "errorType" not in record
    assert "errorMessage" not in record
    assert "AI servisi başlatıldı" not in output
    assert starter.calls == []
    assert_no_secrets(output)


# Starter hata verince açılışın durduğunu ve logda yalnızca istisna türünü doğrular.
def test_starter_error_stops_startup_and_logs_type_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = ConnectionRefusedError(" ".join(FAKE_SECRETS))
    starter = StarterSpy(error)

    with pytest.raises(ConnectionRefusedError) as raised:
        with TestClient(create_app(fake_settings, starter)):
            pass

    assert raised.value is error
    output = capsys.readouterr().out
    errors = [r for r in parse_lines(output) if r["level"] == "error"]

    [record] = errors
    assert record["context"] == "Bootstrap"
    assert record["message"] == "RabbitMQ'ya bağlanılamadı (ConnectionRefusedError)"
    assert "errorType" not in record
    assert "errorMessage" not in record
    assert "AI servisi başlatıldı" not in output
    assert STOPPING_MESSAGE not in output
    assert starter.started == []
    assert_no_secrets(output)


# Başarılı açılış ve kapanışta beklenen logların yazıldığını doğrular.
def test_startup_and_shutdown_are_logged(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(create_app(fake_settings, StarterSpy())) as client:
        client.get("/health")
        started = parse_lines(capsys.readouterr().out)

    stopped = parse_lines(capsys.readouterr().out)

    [start] = [r for r in started if r["message"] == "AI servisi başlatıldı"]
    assert start["level"] == "info"
    assert start["context"] == "Bootstrap"
    assert start["model"] == FAKE_MODEL
    [stop] = [r for r in stopped if r["message"] == STOPPING_MESSAGE]
    assert stop["level"] == "info"
    assert stop["context"] == "Bootstrap"


# Yaşam döngüsü boyunca hiçbir logda sahte gizli değer geçmediğini doğrular.
def test_logs_never_contain_secret_values(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(create_app(fake_settings, StarterSpy())) as client:
        client.get("/health")
        client.get("/docs")

    output = capsys.readouterr().out
    assert output
    assert_no_secrets(output)
