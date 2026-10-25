import asyncio
import io
import json
import logging
import re
import sys
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from app.logs import (
    ALLOWED_FIELDS,
    SYSTEM_CORRELATION_ID,
    UNKNOWN_CORRELATION_ID,
    JsonFormatter,
    configure_logging,
    correlation_id_var,
    correlation_scope,
    get_logger,
)

CONTEXT = "app.documents.pipeline"
BASE_FIELDS = ["timestamp", "level", "context", "message", "correlationId"]
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
UVICORN_LOGGER_NAMES = ("uvicorn", "uvicorn.error", "uvicorn.access")
LIBRARY_LOGGER_NAMES = (
    "pydantic_settings",
    "botocore",
    "boto3",
    "urllib3",
    "httpx",
    "httpcore",
)
LIBRARY_CHILD_LOGGER_NAMES = (
    "botocore.endpoint",
    "urllib3.connectionpool",
    "httpcore.http11",
)
UNTOUCHED_LOGGER_NAMES = ("aio_pika", "aiormq")
ALLOWED_EXTRA = {
    "documentId": "belge-1",
    "recordId": "kayit-1",
    "eventId": "olay-1",
    "eventType": "com.patipasaport.document.uploaded.v1",
    "queue": "ai-service.document-uploaded",
    "attempt": 2,
    "errorCode": "UNREADABLE_DOCUMENT",
    "durationMs": 1532,
    "statusCode": 429,
    "model": "sahte-model",
}
TURKISH_MESSAGE = "Şüpheli değer: ğüşıöç İĞÜŞÖÇ"


class ConsoleBytesIO(io.BytesIO):
    # Akışı yönlendirilmemiş bir konsol gibi gösterir.
    def isatty(self) -> bool:
        return True


# JSON handler'ı capsys kapanmadan kaldırır ve logger ayarlarını geri yükler.
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
    for handler in json_handlers():
        root.removeHandler(handler)
        handler.close()
    root.setLevel(root_level)
    for logger, handlers, level, propagate in saved:
        logger.handlers[:] = handlers
        logger.setLevel(level)
        logger.propagate = propagate
    for logger, level in library_levels:
        logger.setLevel(level)


# Kök logger'da JsonFormatter kullanan handler'ları döndürür.
def json_handlers() -> list[logging.Handler]:
    root = logging.getLogger()
    return [h for h in root.handlers if isinstance(h.formatter, JsonFormatter)]


# Çıktının her satırını tek bir JSON nesnesi olarak okuyup liste halinde döndürür.
def parse_lines(output: str) -> list[dict[str, Any]]:
    assert output.endswith("\n")
    records = [json.loads(line) for line in output.split("\n")[:-1]]
    assert all(isinstance(record, dict) for record in records)
    return records


# Kaydın tek satırlık JSON olduğunu, alan sırasını ve zaman biçimini doğrular.
def test_writes_single_line_json_with_ordered_fields(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    get_logger(CONTEXT).info("Belge %s kuyruğuna alındı", "işleme")

    [record] = parse_lines(capsys.readouterr().out)

    assert list(record) == BASE_FIELDS
    assert TIMESTAMP_PATTERN.fullmatch(record["timestamp"])
    assert record["level"] == "info"
    assert record["context"] == CONTEXT
    assert record["message"] == "Belge işleme kuyruğuna alındı"
    assert record["correlationId"] == SYSTEM_CORRELATION_ID


# Zaman damgasının kaydın zamanından UTC, milisaniyeli ve Z ile üretildiğini doğrular.
def test_timestamp_uses_record_time_in_utc() -> None:
    record = logging.LogRecord(CONTEXT, logging.INFO, __file__, 1, "Zaman", None, None)
    record.created = datetime(2026, 10, 21, 9, 30, 0, 123456, tzinfo=UTC).timestamp()

    data = json.loads(JsonFormatter().format(record))

    assert data == {
        "timestamp": "2026-10-21T09:30:00.123Z",
        "level": "info",
        "context": CONTEXT,
        "message": "Zaman",
        "correlationId": SYSTEM_CORRELATION_ID,
    }


# Seviyelerin debug, info, warn ve error adlarına eşlendiğini doğrular.
def test_maps_levels_to_contract_names(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("DEBUG")
    logger = get_logger(CONTEXT)
    logger.debug("Ayrıntı")
    logger.info("Bilgi")
    logger.warning("Uyarı")
    logger.error("Hata")
    logger.critical("Kritik")

    records = parse_lines(capsys.readouterr().out)

    assert [record["level"] for record in records] == [
        "debug",
        "info",
        "warn",
        "error",
        "error",
    ]


# Kapsam dışında SYSTEM, eksik ya da boş kimlikte UNKNOWN yazıldığını doğrular.
def test_correlation_id_defaults_to_system_and_unknown(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    logger = get_logger(CONTEXT)
    logger.info("Kapsam dışında")
    for missing in (None, "", "   "):
        with correlation_scope(missing):
            logger.info("Kimlik yok")
    with correlation_scope("corr-123"):
        logger.info("Kimlik var")

    records = parse_lines(capsys.readouterr().out)

    assert [record["correlationId"] for record in records] == [
        SYSTEM_CORRELATION_ID,
        UNKNOWN_CORRELATION_ID,
        UNKNOWN_CORRELATION_ID,
        UNKNOWN_CORRELATION_ID,
        "corr-123",
    ]


# İç içe kapsamlarda ve hata çıkışında önceki kimliğe dönüldüğünü doğrular.
def test_correlation_scope_restores_previous_value(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    logger = get_logger(CONTEXT)
    with correlation_scope("dis-kapsam"):
        with correlation_scope("ic-kapsam"):
            logger.info("İç kapsam")
        logger.info("Dış kapsam")
        with pytest.raises(RuntimeError), correlation_scope("hatali-kapsam"):
            raise RuntimeError("Beklenen hata")
        logger.info("Hatadan sonra")
    logger.info("Kapsam dışında")

    records = parse_lines(capsys.readouterr().out)

    assert [record["correlationId"] for record in records] == [
        "ic-kapsam",
        "dis-kapsam",
        "dis-kapsam",
        SYSTEM_CORRELATION_ID,
    ]
    assert correlation_id_var.get() == SYSTEM_CORRELATION_ID


# Eş zamanlı iki asyncio görevinde correlation id'lerin karışmadığını doğrular.
async def test_correlation_scope_isolates_concurrent_tasks(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    logger = get_logger(CONTEXT)
    barrier = asyncio.Barrier(2)

    # Kapsama girer, diğer görevle aynı anda loglar ve gördüğü kimliği döndürür.
    async def run(correlation_id: str) -> str:
        with correlation_scope(correlation_id):
            await barrier.wait()
            logger.info("Görev %s çalışıyor", correlation_id)
            await barrier.wait()
            return correlation_id_var.get()

    seen = await asyncio.gather(run("gorev-a"), run("gorev-b"))

    records = parse_lines(capsys.readouterr().out)

    assert seen == ["gorev-a", "gorev-b"]
    assert len(records) == 2
    for record in records:
        assert record["message"] == f"Görev {record['correlationId']} çalışıyor"
    assert {record["correlationId"] for record in records} == {"gorev-a", "gorev-b"}
    assert correlation_id_var.get() == SYSTEM_CORRELATION_ID


# İzin listesindeki ek alanların yazıldığını, diğerlerinin atıldığını doğrular.
def test_writes_only_allowed_extra_fields(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging()
    blocked = {
        "password": "sahte-parola",
        "content": "sahte belge metni",
        "correlationId": "sahte-kimlik",
        "errorType": "SahteHata",
    }
    get_logger(CONTEXT).info("Olay işlendi", extra={**ALLOWED_EXTRA, **blocked})

    output = capsys.readouterr().out
    [record] = parse_lines(output)

    assert frozenset(ALLOWED_EXTRA) == ALLOWED_FIELDS
    assert list(record) == [*BASE_FIELDS, *ALLOWED_EXTRA]
    assert {name: record[name] for name in ALLOWED_EXTRA} == ALLOWED_EXTRA
    assert record["correlationId"] == SYSTEM_CORRELATION_ID
    assert "sahte-parola" not in output
    assert "sahte belge metni" not in output
    assert "SahteHata" not in output


# JSON'a çevrilemeyen ek alan değerlerinin str() ile yazıldığını doğrular.
def test_writes_unserializable_extra_values_as_strings(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    event_id = uuid.UUID("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b")
    extra = {"eventId": event_id, "durationMs": float("nan")}
    get_logger(CONTEXT).info("Olay alındı", extra=extra)

    [record] = parse_lines(capsys.readouterr().out)

    assert record["eventId"] == str(event_id)
    assert record["durationMs"] == "nan"


# İstisnada errorType ve en fazla 500 karakter errorMessage olduğunu doğrular.
def test_exception_writes_error_fields_without_traceback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    logger = get_logger(CONTEXT)
    try:
        raise ValueError("ğ" * 600)
    except ValueError:
        logger.exception("Belge okunamadı", extra={"errorCode": "UNREADABLE_DOCUMENT"})
    try:
        raise TimeoutError("İstek zaman aşımına uğradı")
    except TimeoutError:
        logger.warning("Tekrar denenecek", exc_info=True)
    logger.error("Etkin istisna yok", exc_info=True)

    output = capsys.readouterr().out
    long_error, short_error, without_error = parse_lines(output)

    assert "Traceback" not in output
    assert list(long_error) == [*BASE_FIELDS, "errorCode", "errorType", "errorMessage"]
    assert long_error["level"] == "error"
    assert long_error["errorType"] == "ValueError"
    assert long_error["errorMessage"] == "ğ" * 500
    assert short_error["level"] == "warn"
    assert short_error["errorType"] == "TimeoutError"
    assert short_error["errorMessage"] == "İstek zaman aşımına uğradı"
    assert list(without_error) == BASE_FIELDS


# Türkçe karakterlerin kaçışsız, satır sonunun kaçışlı yazıldığını doğrular.
def test_writes_turkish_characters_unescaped(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    message = "Şüpheli değer: ğüşıöç İĞÜŞÖÇ\nikinci satır"
    get_logger(CONTEXT).info(message)

    output = capsys.readouterr().out
    [record] = parse_lines(output)

    assert record["message"] == message
    assert "Şüpheli değer: ğüşıöç İĞÜŞÖÇ\\nikinci satır" in output
    assert "\\u" not in output


# configure_logging iki kez çağrılınca kökte tek JSON handler kaldığını doğrular.
def test_configure_logging_twice_keeps_single_root_handler() -> None:
    root = logging.getLogger()
    foreign = list(root.handlers)

    configure_logging()
    first = json_handlers()
    configure_logging("DEBUG")
    current = json_handlers()

    assert len(first) == 1
    assert len(current) == 1
    handler = current[0]
    assert handler is not first[0]
    assert len(root.handlers) == len(foreign) + 1
    assert all(existing in root.handlers for existing in foreign)
    assert isinstance(handler, logging.StreamHandler)
    assert handler.stream is sys.stdout
    assert handler.level == logging.DEBUG
    assert root.level == logging.DEBUG


# uvicorn loglarının köke yayıldığını ve access seviyesinin WARNING olduğunu doğrular.
def test_configure_logging_routes_uvicorn_loggers_to_root(
    capsys: pytest.CaptureFixture[str],
) -> None:
    for name in UVICORN_LOGGER_NAMES:
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.addHandler(logging.StreamHandler(io.StringIO()))
        uvicorn_logger.propagate = False
        uvicorn_logger.setLevel(logging.INFO)

    configure_logging()
    logging.getLogger("uvicorn.error").info("Application startup complete.")
    logging.getLogger("uvicorn.access").info('"GET /health HTTP/1.1" 200')
    logging.getLogger("uvicorn.access").warning('"GET /health HTTP/1.1" 503')

    records = parse_lines(capsys.readouterr().out)

    for name in UVICORN_LOGGER_NAMES:
        assert logging.getLogger(name).handlers == []
        assert logging.getLogger(name).propagate is True
    assert logging.getLogger("uvicorn.access").level == logging.WARNING
    assert [(record["context"], record["level"]) for record in records] == [
        ("uvicorn.error", "info"),
        ("uvicorn.access", "warn"),
    ]


# WARNING seviyesinde, seviyesi INFO olan uvicorn.error'ın INFO yazmadığını doğrular.
def test_log_level_is_floor_for_logger_with_own_level(
    capsys: pytest.CaptureFixture[str],
) -> None:
    uvicorn_error = logging.getLogger("uvicorn.error")
    uvicorn_error.setLevel(logging.INFO)

    configure_logging("WARNING")
    uvicorn_error.info("Application startup complete.")
    uvicorn_error.warning("Invalid HTTP request received.")

    records = parse_lines(capsys.readouterr().out)

    assert uvicorn_error.level == logging.INFO
    assert [(record["context"], record["level"]) for record in records] == [
        ("uvicorn.error", "warn"),
    ]
    assert records[0]["message"] == "Invalid HTTP request received."


# DEBUG seviyesinde bile kütüphane logger'larının WARNING altını yazmadığını doğrular.
def test_library_loggers_are_pinned_to_warning(
    capsys: pytest.CaptureFixture[str],
) -> None:
    untouched = {name: logging.getLogger(name).level for name in UNTOUCHED_LOGGER_NAMES}

    configure_logging("DEBUG")
    for name in LIBRARY_LOGGER_NAMES:
        library_logger = logging.getLogger(name)
        library_logger.debug("Ayrıntı")
        library_logger.info("Bilgi")
        library_logger.warning("Uyarı")
    for name in LIBRARY_CHILD_LOGGER_NAMES:
        logging.getLogger(name).debug("Alt logger ayrıntısı")
        logging.getLogger(name).info("Alt logger bilgisi")

    records = parse_lines(capsys.readouterr().out)

    assert [(record["context"], record["level"]) for record in records] == [
        (name, "warn") for name in LIBRARY_LOGGER_NAMES
    ]
    for name in LIBRARY_LOGGER_NAMES:
        assert logging.getLogger(name).level == logging.WARNING
    assert {name: logging.getLogger(name).level for name in untouched} == untouched


# cp1254 kodlamalı stdout'ta Türkçe mesajın UTF-8 bayt olarak yazıldığını doğrular.
def test_configure_logging_writes_utf8_to_non_utf8_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(raw, encoding="cp1254"))

    configure_logging()
    get_logger(CONTEXT).info(TURKISH_MESSAGE)

    [record] = parse_lines(raw.getvalue().decode("utf-8"))

    assert record["message"] == TURKISH_MESSAGE
    assert TURKISH_MESSAGE.encode("utf-8") in raw.getvalue()


# Konsoldaki ya da zaten UTF-8 olan stdout'un ayarlarının değişmediğini doğrular.
def test_configure_logging_leaves_console_and_utf8_stdout_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    console = io.TextIOWrapper(ConsoleBytesIO(), encoding="cp1254")
    utf8_stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")

    for stream in (console, utf8_stream):
        monkeypatch.setattr(sys, "stdout", stream)
        configure_logging()

    assert (console.encoding, console.errors) == ("cp1254", "strict")
    assert (utf8_stream.encoding, utf8_stream.errors) == ("utf-8", "strict")


# Yeniden yapılandırılamayan stdout'a bugünkü gibi yazılmaya devam edildiğini doğrular.
def test_configure_logging_keeps_stream_that_cannot_be_reconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stream)

    configure_logging()
    get_logger(CONTEXT).info(TURKISH_MESSAGE)

    [record] = parse_lines(stream.getvalue())

    assert record["message"] == TURKISH_MESSAGE


# stdout None iken configure_logging'in hata vermeden handler kurduğunu doğrular.
def test_configure_logging_tolerates_missing_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "stdout", None)

    configure_logging()

    assert len(json_handlers()) == 1


# aio-pika biçimindeki mesajlarda kullanıcı ve şifrenin gizlendiğini doğrular.
def test_masks_credentials_in_aio_pika_style_messages(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    url = "amqp://sahte_kullanici:******@localhost:5672/"
    logger = logging.getLogger("aio_pika.robust_connection")
    logger.info("Connection to %s closed. Reconnecting after %r seconds.", url, 5)
    logger.warning('Connection attempt to "%s" failed: refused.', url)

    output = capsys.readouterr().out
    closed, failed = parse_lines(output)

    assert "sahte_kullanici" not in output
    assert "******" not in output
    assert closed["message"] == (
        "Connection to amqp://***@localhost:5672/ closed. Reconnecting after 5 seconds."
    )
    assert failed["message"] == (
        'Connection attempt to "amqp://***@localhost:5672/" failed: refused.'
    )


# errorMessage içindeki adresin kırpılmadan önce maskelendiğini doğrular.
def test_masks_credentials_in_error_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    logger = get_logger(CONTEXT)
    try:
        raise ConnectionError("Bağlantı amqp://sahte:sahte-parola@rabbitmq:5672/ red")
    except ConnectionError:
        logger.exception("Bağlantı kurulamadı")
    try:
        raise ConnectionError("x" * 490 + " amqp://sahte:sahte-parola@rabbitmq:5672/")
    except ConnectionError:
        logger.exception("Uzun hata")

    output = capsys.readouterr().out
    short_error, long_error = parse_lines(output)

    assert "sahte" not in output
    assert short_error["errorMessage"] == "Bağlantı amqp://***@rabbitmq:5672/ red"
    assert long_error["errorMessage"] == ("x" * 490 + " amqp://***@rabbitmq")[:500]


# Çoklu adres, https, yalnız kullanıcı adı ve @ içeren şifrenin gizlendiğini doğrular.
def test_masks_credentials_in_multiple_urls(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    get_logger(CONTEXT).info(
        "Birincil amqp://sahte:sahte-parola@rabbitmq:5672/, "
        "yedek amqps://sahte@rabbitmq-2:5671/vhost, "
        "API https://sahte:sahte-parola@ai.example.invalid/v1, "
        "depo s3://sahte:par@la@seaweedfs:8333"
    )

    [record] = parse_lines(capsys.readouterr().out)

    assert record["message"] == (
        "Birincil amqp://***@rabbitmq:5672/, "
        "yedek amqps://***@rabbitmq-2:5671/vhost, "
        "API https://***@ai.example.invalid/v1, "
        "depo s3://***@seaweedfs:8333"
    )


# Kimlik bilgisi olmayan adresin ve şemasız ad@alan metninin değişmediğini doğrular.
def test_leaves_text_without_credentials_unchanged(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging()
    message = (
        "Adres amqp://rabbitmq:5672/, iletişim destek@ornek.com, "
        "uç https://ai.example.invalid/v1?ref=a@b"
    )
    get_logger(CONTEXT).info(message)

    [record] = parse_lines(capsys.readouterr().out)

    assert record["message"] == message


# Maskelemenin yalnızca çıktıda yapıldığını, kaydın değişmediğini doğrular.
def test_masking_does_not_modify_record() -> None:
    url = "amqp://sahte:sahte-parola@rabbitmq:5672/"
    record = logging.LogRecord(
        CONTEXT, logging.INFO, __file__, 1, "Adres %s", (url,), None
    )

    data = json.loads(JsonFormatter().format(record))

    assert data["message"] == "Adres amqp://***@rabbitmq:5672/"
    assert record.getMessage() == f"Adres {url}"
    assert record.args == (url,)
