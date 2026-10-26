import asyncio
import inspect
import io
import json
import logging
from collections.abc import Callable, Iterator, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import ConfigError, Settings, load_settings
from app.documents.pipeline import DocumentPipeline
from app.generated import events_pb2
from app.llm.client import LlmClient, LlmReply, create_llm_client
from app.logs import JsonFormatter
from app.main import create_app
from app.messaging.cloudevents import (
    DOCUMENT_ANALYZED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_UPLOADED,
    IncomingEvent,
    OutgoingEvent,
)
from app.messaging.consumer import Flow
from app.messaging.publisher import Publisher
from app.messaging.runtime import Messaging, start_messaging
from app.messaging.topology import DOCUMENT_PREFETCH, DOCUMENT_QUEUE
from app.storage import DocumentStorage, create_storage

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
STARTED_MESSAGE = "AI servisi başlatıldı"
DOCUMENT_ID = "0dfc0a17-8fb6-4f0b-9732-6a8ca67465de"
STORAGE_PATH = "3f2b8c1d-6a4e-4b7f-9c0d-1e2f3a4b5c6d.png"
SHA256 = "0123456789abcdef" * 4
VALID_OUTPUT = json.dumps(
    {
        "isMedicalDocument": True,
        "confidence": 0.8,
        "proposal": {
            "type": "EXAMINATION",
            "title": "Genel muayene",
            "notes": "",
            "recordedAt": "2024-03-15",
            "labResult": None,
            "vaccination": None,
            "prescription": None,
        },
    }
)


class StartupError(Exception):
    pass


class CloseError(Exception):
    pass


class FakeMessaging:
    # Sahte mesajlaşmayı zaman çizelgesi ve isteğe bağlı durdurma hatasıyla oluşturur.
    def __init__(self, timeline: list[str], stop_error: Exception | None) -> None:
        self.timeline = timeline
        self.stop_error = stop_error
        self.stop_calls = 0

    # Durdurma çağrısını sayar, zaman çizelgesine yazar; tanımlıysa hatayı fırlatır.
    async def stop(self) -> None:
        self.stop_calls += 1
        self.timeline.append("messaging.stop")
        if self.stop_error is not None:
            raise self.stop_error


class StarterSpy:
    # Ayarları ve akışları kaydeden, sahte mesajlaşma döndüren ya da hata veren starter.
    def __init__(
        self,
        timeline: list[str],
        error: Exception | None = None,
        stop_error: Exception | None = None,
    ) -> None:
        self.timeline = timeline
        self.error = error
        self.stop_error = stop_error
        self.calls: list[tuple[Settings, tuple[Flow, ...]]] = []
        self.started: list[FakeMessaging] = []

    # Ayarları ve akışları kaydeder; tanımlıysa hatayı fırlatır, değilse sahte döndürür.
    async def __call__(self, settings: Settings, flows: Sequence[Flow]) -> Messaging:
        self.calls.append((settings, tuple(flows)))
        self.timeline.append("messaging.start")
        if self.error is not None:
            raise self.error
        messaging = FakeMessaging(self.timeline, self.stop_error)
        self.started.append(messaging)
        return cast(Messaging, messaging)


class FakeStorage:
    # Okuma isteklerini kaydeden ve verilen içeriği döndüren sahte depoyu kurar.
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.reads: list[tuple[str, int, str]] = []

    # Okuma argümanlarını kaydedip içeriği döndürür.
    async def read(
        self, storage_path: str, expected_size: int, expected_sha256: str
    ) -> bytes:
        self.reads.append((storage_path, expected_size, expected_sha256))
        return self.content


class FakeLlm:
    # İstekleri ve kapanışı kaydeden, istenirse kapanışta hata veren sahte istemci.
    def __init__(self, timeline: list[str], close_error: Exception | None) -> None:
        self.timeline = timeline
        self.close_error = close_error
        self.requests: list[Mapping[str, Any]] = []
        self.aclose_calls = 0

    # İsteği kaydeder ve geçerli bir model çıktısı döndürür.
    async def complete_json(self, **request: Any) -> LlmReply:
        self.requests.append(request)
        return LlmReply(VALID_OUTPUT, prompt_tokens=None, completion_tokens=None)

    # Kapanışı sayar, zaman çizelgesine yazar; tanımlıysa hatayı fırlatır.
    async def aclose(self) -> None:
        self.aclose_calls += 1
        self.timeline.append("llm.aclose")
        if self.close_error is not None:
            raise self.close_error


class FactorySpy[T]:
    # Aldığı ayarları kaydeden, ürünü döndüren ya da hata veren sahte fabrika kurar.
    def __init__(
        self, timeline: list[str], name: str, product: T, error: Exception | None
    ) -> None:
        self.timeline = timeline
        self.name = name
        self.product = product
        self.error = error
        self.calls: list[Settings] = []

    # Ayarları kaydeder; tanımlıysa hatayı fırlatır, değilse ürünü döndürür.
    def __call__(self, settings: Settings) -> T:
        self.calls.append(settings)
        self.timeline.append(self.name)
        if self.error is not None:
            raise self.error
        return self.product


class FakePublisher:
    # Yayınlanan olayları kaydeden sahte yayıncıyı kurar.
    def __init__(self) -> None:
        self.events: list[OutgoingEvent] = []

    # Olayı kaydeder.
    async def publish(self, event: OutgoingEvent) -> None:
        self.events.append(event)


class Harness:
    # Sahte starter, depo ve istemci fabrikalarını ortak zaman çizelgesiyle kurar.
    def __init__(
        self,
        *,
        starter_error: Exception | None = None,
        stop_error: Exception | None = None,
        storage_error: Exception | None = None,
        llm_error: Exception | None = None,
        close_error: Exception | None = None,
    ) -> None:
        self.timeline: list[str] = []
        self.starter = StarterSpy(self.timeline, starter_error, stop_error)
        self.storage = FakeStorage(png_bytes())
        self.llm = FakeLlm(self.timeline, close_error)
        self.storage_factory = FactorySpy(
            self.timeline,
            "storage_factory",
            cast(DocumentStorage, self.storage),
            storage_error,
        )
        self.llm_factory = FactorySpy(
            self.timeline, "llm_factory", cast(LlmClient, self.llm), llm_error
        )

    # Sahte bağımlılıklarla ve verilen ayar yükleyicisiyle uygulamayı oluşturur.
    def app(self, settings_loader: Callable[[], Settings] | None = None) -> FastAPI:
        return create_app(
            fake_settings if settings_loader is None else settings_loader,
            self.starter,
            storage_factory=self.storage_factory,
            llm_factory=self.llm_factory,
        )


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
def fake_settings(ai_model: str = FAKE_MODEL) -> Settings:
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
        ai_model=ai_model,
        ai_request_timeout_seconds=30.0,
        log_level="INFO",
    )


# Her zaman yalnızca ayar adlarını içeren ConfigError fırlatan sahte yükleyici.
def failing_loader() -> Settings:
    raise ConfigError(CONFIG_ERROR_MESSAGE)


# Küçük, geçerli bir PNG görselinin baytlarını üretir.
def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 3), (10, 120, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


# Sahte depodaki PNG için geçerli bir document.uploaded olayı üretir.
def uploaded_event(size_bytes: int) -> IncomingEvent:
    return IncomingEvent(
        id="5d0f7a2e-1c3b-4e8f-9a6d-2b7c8e9f0a1b",
        type=DOCUMENT_UPLOADED,
        source="/patipasaport/medical-record",
        subject=DOCUMENT_ID,
        time=datetime(2024, 3, 20, 9, 0, tzinfo=UTC),
        data=events_pb2.DocumentUploaded(
            document_id=DOCUMENT_ID,
            pet_id="1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5c",
            clinic_id="6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718",
            storage_path=STORAGE_PATH,
            mime_type="image/png",
            size_bytes=size_bytes,
            sha256=SHA256,
        ),
    )


# Çıktının her satırını JSON nesnesi olarak okuyup liste halinde döndürür.
def parse_lines(output: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in output.splitlines() if line.strip()]


# Çıktıda sahte gizli değerlerin hiçbirinin geçmediğini doğrular.
def assert_no_secrets(output: str) -> None:
    for secret in FAKE_SECRETS:
        assert secret not in output


# Açılış hatasının tek Bootstrap error loguna yalnızca türüyle yazıldığını doğrular.
def assert_single_bootstrap_error(output: str, message: str) -> None:
    errors = [r for r in parse_lines(output) if r["level"] == "error"]
    [record] = errors
    assert record["context"] == "Bootstrap"
    assert record["message"] == message
    assert "errorType" not in record
    assert "errorMessage" not in record
    assert STARTED_MESSAGE not in output
    assert STOPPING_MESSAGE not in output
    assert_no_secrets(output)


# /health ucunun 200 ve doğru gövde döndürdüğünü doğrular.
def test_health_returns_ok() -> None:
    with TestClient(Harness().app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# Belgelendirme uçlarının kapalı olduğunu doğrular.
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_routes_are_disabled(path: str) -> None:
    with TestClient(Harness().app()) as client:
        response = client.get(path)

    assert response.status_code == 404


# Yükleyicinin döndürdüğü ayar nesnesinin app.state'e konduğunu doğrular.
def test_state_holds_loaded_settings() -> None:
    settings = fake_settings()
    app = Harness().app(lambda: settings)

    with TestClient(app):
        assert app.state.settings is settings


# Uygulamayı oluşturmanın yükleyiciyi, fabrikaları ve starter'ı çağırmadığını doğrular.
def test_creating_app_does_not_load_settings() -> None:
    calls: list[int] = []
    harness = Harness()

    # Çağrıldığını kaydedip sahte ayarları döndürür.
    def loader() -> Settings:
        calls.append(1)
        return fake_settings()

    app = harness.app(loader)
    assert calls == []
    assert harness.timeline == []

    with TestClient(app):
        assert calls == [1]
        assert len(harness.starter.calls) == 1


# Varsayılan bağımlılıkların gerçek yükleyici, starter ve fabrikalar olduğunu doğrular.
def test_default_dependencies() -> None:
    parameters = inspect.signature(create_app).parameters

    assert parameters["settings_loader"].default is load_settings
    assert parameters["messaging_starter"].default is start_messaging
    assert parameters["storage_factory"].default is create_storage
    assert parameters["llm_factory"].default is create_llm_client
    assert parameters["storage_factory"].kind is inspect.Parameter.KEYWORD_ONLY
    assert parameters["llm_factory"].kind is inspect.Parameter.KEYWORD_ONLY


# Fabrikalara ve starter'a yükleyicinin döndürdüğü ayar nesnesinin verildiğini doğrular.
def test_dependencies_receive_loaded_settings() -> None:
    settings = fake_settings()
    harness = Harness()

    with TestClient(harness.app(lambda: settings)):
        [(started_settings, _)] = harness.starter.calls

    assert started_settings is settings
    assert harness.storage_factory.calls == [settings]
    assert harness.storage_factory.calls[0] is settings
    assert harness.llm_factory.calls[0] is settings
    assert harness.timeline[:3] == ["storage_factory", "llm_factory", "messaging.start"]


# Lifespan'ın depo ve istemciden belge akışını kurup starter'a verdiğini doğrular.
def test_lifespan_passes_document_flow_built_from_storage_and_llm() -> None:
    harness = Harness()

    with TestClient(harness.app()):
        [(_, flows)] = harness.starter.calls

    [flow] = flows
    assert flow.queue == DOCUMENT_QUEUE
    assert flow.event_type == DOCUMENT_UPLOADED
    assert flow.prefetch == DOCUMENT_PREFETCH
    pipeline = getattr(flow.handle, "__self__", None)
    assert isinstance(pipeline, DocumentPipeline)
    assert pipeline.model_version == f"{FAKE_MODEL}/extract-v1"
    assert flow.build_failure == pipeline.build_failure
    content = harness.storage.content
    publisher = FakePublisher()

    asyncio.run(flow.handle(uploaded_event(len(content)), cast(Publisher, publisher)))

    assert harness.storage.reads == [(STORAGE_PATH, len(content), SHA256)]
    assert len(harness.llm.requests) == 1
    assert [event.type for event in publisher.events] == [
        DOCUMENT_PROCESSING_STARTED,
        DOCUMENT_ANALYZED,
    ]


# Starter'ın döndürdüğü mesajlaşma nesnesinin app.state'e konduğunu doğrular.
def test_state_holds_started_messaging() -> None:
    harness = Harness()
    app = harness.app()

    with TestClient(app):
        [messaging] = harness.starter.started
        assert app.state.messaging is messaging


# Kapanışta durduruluyor logundan sonra önce stop, sonra aclose çağrıldığını doğrular.
def test_shutdown_stops_messaging_then_closes_llm() -> None:
    harness = Harness()
    bootstrap = logging.getLogger("Bootstrap")
    handler = TimelineHandler(harness.timeline)
    bootstrap.addHandler(handler)
    try:
        with TestClient(harness.app()):
            [messaging] = harness.starter.started
            assert messaging.stop_calls == 0
            assert harness.llm.aclose_calls == 0
    finally:
        bootstrap.removeHandler(handler)

    assert messaging.stop_calls == 1
    assert harness.llm.aclose_calls == 1
    assert harness.timeline[-3:] == [STOPPING_MESSAGE, "messaging.stop", "llm.aclose"]


# Mesajlaşma durdurulamasa da istemcinin kapatılıp hatanın fırladığını doğrular.
def test_shutdown_closes_llm_even_if_messaging_stop_fails() -> None:
    error = StartupError("durmadı")
    harness = Harness(stop_error=error)

    with pytest.raises(StartupError) as raised:
        with TestClient(harness.app()):
            pass

    assert raised.value is error
    assert harness.llm.aclose_calls == 1
    assert harness.timeline[-2:] == ["messaging.stop", "llm.aclose"]


# Ayar hatasında açılışın durduğunu ve error logunda yalnızca adlar olduğunu doğrular.
def test_config_error_stops_startup_and_logs_names_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    harness = Harness()

    with pytest.raises(ConfigError), TestClient(harness.app(failing_loader)):
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
    assert STARTED_MESSAGE not in output
    assert harness.timeline == []
    assert_no_secrets(output)


# Starter hata verince istemcinin kapandığını ve logda yalnızca türün olduğunu doğrular.
def test_starter_error_closes_llm_and_logs_type_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = ConnectionRefusedError(" ".join(FAKE_SECRETS))
    harness = Harness(starter_error=error)

    with pytest.raises(ConnectionRefusedError) as raised:
        with TestClient(harness.app()):
            pass

    assert raised.value is error
    assert_single_bootstrap_error(
        capsys.readouterr().out, "RabbitMQ'ya bağlanılamadı (ConnectionRefusedError)"
    )
    assert harness.starter.started == []
    assert harness.llm.aclose_calls == 1
    assert harness.timeline[-2:] == ["messaging.start", "llm.aclose"]


# Akış kurulamazsa istemcinin kapandığını ve starter'ın çağrılmadığını doğrular.
def test_pipeline_error_closes_llm_and_logs_type_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    harness = Harness()

    with pytest.raises(ValueError):
        with TestClient(harness.app(lambda: fake_settings("m" * 60))):
            pass

    assert_single_bootstrap_error(
        capsys.readouterr().out, "Belge okuma akışı kurulamadı (ValueError)"
    )
    assert harness.starter.calls == []
    assert harness.llm.aclose_calls == 1
    assert harness.timeline == ["storage_factory", "llm_factory", "llm.aclose"]


# Depo kurulamazsa istemcinin kurulmadığını ve logda yalnızca türün olduğunu doğrular.
def test_storage_factory_error_stops_startup(
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = StartupError(" ".join(FAKE_SECRETS))
    harness = Harness(storage_error=error)

    with pytest.raises(StartupError) as raised:
        with TestClient(harness.app()):
            pass

    assert raised.value is error
    assert_single_bootstrap_error(
        capsys.readouterr().out,
        "Dosya deposu ya da AI API istemcisi kurulamadı (StartupError)",
    )
    assert harness.timeline == ["storage_factory"]


# İstemci kurulamazsa açılışın durduğunu ve kapatılacak istemci olmadığını doğrular.
def test_llm_factory_error_stops_startup(capsys: pytest.CaptureFixture[str]) -> None:
    error = StartupError(" ".join(FAKE_SECRETS))
    harness = Harness(llm_error=error)

    with pytest.raises(StartupError) as raised:
        with TestClient(harness.app()):
            pass

    assert raised.value is error
    assert_single_bootstrap_error(
        capsys.readouterr().out,
        "Dosya deposu ya da AI API istemcisi kurulamadı (StartupError)",
    )
    assert harness.llm.aclose_calls == 0
    assert harness.timeline == ["storage_factory", "llm_factory"]


# İstemci kapatılamazsa asıl hatanın fırladığını, yalnızca türün loglandığını doğrular.
def test_close_failure_after_startup_error_keeps_original_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = ConnectionRefusedError("reddedildi")
    harness = Harness(starter_error=error, close_error=CloseError(FAKE_SECRETS[3]))

    with pytest.raises(ConnectionRefusedError) as raised:
        with TestClient(harness.app()):
            pass

    assert raised.value is error
    output = capsys.readouterr().out
    warnings = [
        r
        for r in parse_lines(output)
        if r["level"] == "warn" and r["context"] == "Bootstrap"
    ]
    [record] = warnings
    assert record["message"] == (
        "Açılış hatasından sonra AI API istemcisi kapatılamadı (CloseError)"
    )
    assert "errorType" not in record
    assert "errorMessage" not in record
    assert harness.llm.aclose_calls == 1
    assert_no_secrets(output)


# Başarılı açılış ve kapanışta beklenen logların yazıldığını doğrular.
def test_startup_and_shutdown_are_logged(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(Harness().app()) as client:
        client.get("/health")
        started = parse_lines(capsys.readouterr().out)

    stopped = parse_lines(capsys.readouterr().out)

    [start] = [r for r in started if r["message"] == STARTED_MESSAGE]
    assert start["level"] == "info"
    assert start["context"] == "Bootstrap"
    assert start["model"] == FAKE_MODEL
    [stop] = [r for r in stopped if r["message"] == STOPPING_MESSAGE]
    assert stop["level"] == "info"
    assert stop["context"] == "Bootstrap"


# Yaşam döngüsü boyunca hiçbir logda sahte gizli değer geçmediğini doğrular.
def test_logs_never_contain_secret_values(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(Harness().app()) as client:
        client.get("/health")
        client.get("/docs")

    output = capsys.readouterr().out
    assert output
    assert_no_secrets(output)
