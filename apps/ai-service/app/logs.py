import codecs
import contextvars
import io
import json
import logging
import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime

SYSTEM_CORRELATION_ID = "SYSTEM"
UNKNOWN_CORRELATION_ID = "UNKNOWN"
ALLOWED_FIELDS: frozenset[str] = frozenset(
    {
        "documentId",
        "recordId",
        "eventId",
        "eventType",
        "queue",
        "attempt",
        "errorCode",
        "durationMs",
        "statusCode",
        "model",
        "retryAfterSeconds",
        "promptTokens",
        "completionTokens",
    }
)

correlation_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "correlation_id", default=SYSTEM_CORRELATION_ID
)

_HANDLER_NAME = "patipasaport-json-stdout"
_ERROR_MESSAGE_LIMIT = 500
_URL_USERINFO = re.compile(
    r"(?<![A-Za-z0-9+.\-])([A-Za-z][A-Za-z0-9+.\-]*://)[^\s/?#]+@"
)
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")
_WARNING_ONLY_LOGGERS = (
    "pydantic_settings",
    "botocore",
    "boto3",
    "urllib3",
    "httpx",
    "httpcore",
)


# Kayıt zamanını milisaniyeli ve Z ile biten UTC ISO-8601 metnine çevirir.
def _format_timestamp(created: float) -> str:
    moment = datetime.fromtimestamp(created, tz=UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Sayısal log seviyesini debug, info, warn ya da error adlarından birine eşler.
def _level_name(levelno: int) -> str:
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warn"
    if levelno >= logging.INFO:
        return "info"
    return "debug"


# Metindeki şema://kullanıcı-bilgisi@ adreslerinde kullanıcı bilgisini *** yapar.
def _mask_credentials(text: str) -> str:
    if "://" not in text:
        return text
    return _URL_USERINFO.sub(r"\1***@", text)


# Değer JSON'a çevrilebiliyorsa aynen, çevrilemiyorsa str() karşılığını döndürür.
def _json_value(value: object) -> object:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except TypeError, ValueError:
        return str(value)
    return value


class JsonFormatter(logging.Formatter):
    # Kaydı izin listesine uyan tek satırlık bir JSON nesnesine çevirir.
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": _format_timestamp(record.created),
            "level": _level_name(record.levelno),
            "context": record.name,
            "message": _mask_credentials(record.getMessage()),
            "correlationId": correlation_id_var.get(),
        }
        for name, value in record.__dict__.items():
            if name in ALLOWED_FIELDS:
                payload[name] = _json_value(value)
        error = record.exc_info[1] if record.exc_info else None
        if error is not None:
            payload["errorType"] = type(error).__name__
            masked = _mask_credentials(str(error))
            payload["errorMessage"] = masked[:_ERROR_MESSAGE_LIMIT]
        return json.dumps(payload, ensure_ascii=False, allow_nan=False)


# Yönlendirilmiş stdout UTF-8 değilse aynı akışı UTF-8'e çevirir, olmazsa dokunmaz.
def _ensure_utf8_stdout() -> None:
    stream = sys.stdout
    if not isinstance(stream, io.TextIOWrapper):
        return
    with suppress(LookupError, OSError, ValueError):
        if not stream.isatty() and codecs.lookup(stream.encoding).name != "utf-8":
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


# UTF-8 stdout'a JSON handler'ı, seviye sınırlarını ve uvicorn yönlendirmesini kurar.
def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())
    _ensure_utf8_stdout()
    for previous in [h for h in root.handlers if h.name == _HANDLER_NAME]:
        root.removeHandler(previous)
        previous.close()
    handler = logging.StreamHandler(sys.stdout)
    handler.set_name(_HANDLER_NAME)
    handler.setLevel(root.level)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    for name in _UVICORN_LOGGERS:
        uvicorn_logger = logging.getLogger(name)
        for existing in list(uvicorn_logger.handlers):
            uvicorn_logger.removeHandler(existing)
        uvicorn_logger.propagate = True
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    for name in _WARNING_ONLY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


# Adı verilen bağlam olan logger'ı döndürür.
def get_logger(context: str) -> logging.Logger:
    return logging.getLogger(context)


# Blokta correlation id'yi ayarlar; boşsa UNKNOWN kullanır, çıkışta eskisine döner.
@contextmanager
def correlation_scope(correlation_id: str | None) -> Iterator[None]:
    if correlation_id is None or not correlation_id.strip():
        correlation_id = UNKNOWN_CORRELATION_ID
    token = correlation_id_var.set(correlation_id)
    try:
        yield
    finally:
        correlation_id_var.reset(token)
