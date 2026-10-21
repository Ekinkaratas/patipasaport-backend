import json
import logging
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings
from app.logs import JsonFormatter
from app.main import create_app

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
    with TestClient(create_app(fake_settings)) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# Belgelendirme uçlarının kapalı olduğunu doğrular.
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_routes_are_disabled(path: str) -> None:
    with TestClient(create_app(fake_settings)) as client:
        response = client.get(path)

    assert response.status_code == 404


# Yükleyicinin döndürdüğü ayar nesnesinin app.state'e konduğunu doğrular.
def test_state_holds_loaded_settings() -> None:
    settings = fake_settings()
    app = create_app(lambda: settings)

    with TestClient(app):
        assert app.state.settings is settings


# Uygulamayı oluşturmanın yükleyiciyi çağırmadığını doğrular.
def test_creating_app_does_not_load_settings() -> None:
    calls: list[int] = []

    # Çağrıldığını kaydedip sahte ayarları döndürür.
    def loader() -> Settings:
        calls.append(1)
        return fake_settings()

    app = create_app(loader)
    assert calls == []

    with TestClient(app):
        assert calls == [1]


# Ayar hatasında açılışın durduğunu ve error logunda yalnızca adlar olduğunu doğrular.
def test_config_error_stops_startup_and_logs_names_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(ConfigError), TestClient(create_app(failing_loader)):
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
    assert_no_secrets(output)


# Başarılı açılış ve kapanışta beklenen logların yazıldığını doğrular.
def test_startup_and_shutdown_are_logged(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(create_app(fake_settings)) as client:
        client.get("/health")
        started = parse_lines(capsys.readouterr().out)

    stopped = parse_lines(capsys.readouterr().out)

    [start] = [r for r in started if r["message"] == "AI servisi başlatıldı"]
    assert start["level"] == "info"
    assert start["context"] == "Bootstrap"
    assert start["model"] == FAKE_MODEL
    [stop] = [r for r in stopped if r["message"] == "AI servisi durduruluyor"]
    assert stop["level"] == "info"
    assert stop["context"] == "Bootstrap"


# Yaşam döngüsü boyunca hiçbir logda sahte gizli değer geçmediğini doğrular.
def test_logs_never_contain_secret_values(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(create_app(fake_settings)) as client:
        client.get("/health")
        client.get("/docs")

    output = capsys.readouterr().out
    assert output
    assert_no_secrets(output)
