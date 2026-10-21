import re
from pathlib import Path
from typing import Annotated, Any

from pydantic import AfterValidator, BeforeValidator, Field, SecretStr, ValidationError
from pydantic_core import ErrorDetails, PydanticCustomError, PydanticUseDefault
from pydantic_settings import BaseSettings, SettingsConfigDict

PLACEHOLDER: str = "bu alan doldurulacak"
DEFAULT_ENV_FILE: Path = Path(__file__).resolve().parents[1] / ".env"
LOG_LEVELS: tuple[str, ...] = ("DEBUG", "INFO", "WARNING", "ERROR")
_UNFILLED_ERROR_TYPE = "unfilled_setting"
_MISSING_ERROR_TYPES = frozenset({"missing", _UNFILLED_ERROR_TYPE})
_SURROUNDING_SPACES_AND_QUOTES = re.compile(r"^[\s\"']+|[\s\"']+$")


class ConfigError(Exception):
    pass


# Değerin başındaki ve sonundaki boşlukları ve tırnakları atar.
def _strip_spaces_and_quotes(value: str) -> str:
    return _SURROUNDING_SPACES_AND_QUOTES.sub("", value)


# Zorunlu bir değer boş, yalnızca boşluk ya da yer tutucuysa doğrulama hatası verir.
def _reject_unfilled(value: Any) -> Any:
    raw = value.get_secret_value() if isinstance(value, SecretStr) else value
    if isinstance(raw, str) and _strip_spaces_and_quotes(raw) in ("", PLACEHOLDER):
        raise PydanticCustomError(_UNFILLED_ERROR_TYPE, "Ayar doldurulmamış")
    return value


# Varsayılanlı bir değer boşsa varsayılanı kullandırır, yer tutucuysa hata verir.
def _default_or_unfilled(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = _strip_spaces_and_quotes(value)
    if not stripped:
        raise PydanticUseDefault()
    if stripped == PLACEHOLDER:
        raise PydanticCustomError(_UNFILLED_ERROR_TYPE, "Ayar doldurulmamış")
    return value


# Log seviyesini büyük harfe çevirir ve izin verilen seviyelerden biri olmasını ister.
def _normalize_log_level(value: str) -> str:
    level = value.upper()
    if level not in LOG_LEVELS:
        raise ValueError("Geçersiz log seviyesi")
    return level


RequiredStr = Annotated[str, BeforeValidator(_reject_unfilled)]
RequiredSecretStr = Annotated[SecretStr, BeforeValidator(_reject_unfilled)]
DefaultedStr = Annotated[str, BeforeValidator(_default_or_unfilled)]
DefaultedInt = Annotated[int, BeforeValidator(_default_or_unfilled)]
DefaultedFloat = Annotated[float, BeforeValidator(_default_or_unfilled)]
LogLevel = Annotated[DefaultedStr, AfterValidator(_normalize_log_level)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_file_encoding="utf-8")

    rabbitmq_host: RequiredStr
    rabbitmq_port: DefaultedInt = Field(default=5672, ge=1, le=65535)
    ai_rabbitmq_user: RequiredStr
    ai_rabbitmq_password: RequiredSecretStr
    s3_endpoint: RequiredStr
    s3_bucket: DefaultedStr = "medical-documents"
    s3_access_key: RequiredSecretStr
    s3_secret_key: RequiredSecretStr
    ai_api_base_url: RequiredStr
    ai_api_key: RequiredSecretStr
    ai_model: RequiredStr
    ai_request_timeout_seconds: DefaultedFloat = Field(
        default=120.0, gt=0, allow_inf_nan=False
    )
    log_level: LogLevel = "INFO"


# Doğrulama hatalarından eksik ve geçersiz ayar adlarını alfabetik veren mesajı kurar.
def _failure_message(details: list[ErrorDetails]) -> str:
    missing: set[str] = set()
    invalid: set[str] = set()
    for detail in details:
        name = str(detail["loc"][0]).upper()
        if detail["type"] in _MISSING_ERROR_TYPES:
            missing.add(name)
        else:
            invalid.add(name)
    parts: list[str] = []
    if missing:
        parts.append(f"Eksik ya da doldurulmamış ayarlar: {', '.join(sorted(missing))}")
    if invalid:
        parts.append(f"Geçersiz ayarlar: {', '.join(sorted(invalid))}")
    return ". ".join(parts)


# Ayarları ortamdan ve env dosyasından okur; sorun varsa yalnızca adları bildirir.
def load_settings(env_file: Path | None = DEFAULT_ENV_FILE) -> Settings:
    try:
        return Settings(_env_file=env_file)
    except ValidationError as error:
        details = error.errors(
            include_url=False, include_context=False, include_input=False
        )
    raise ConfigError(_failure_message(details)) from None
