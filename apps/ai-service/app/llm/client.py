import json
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from app.config import Settings
from app.errors import AI_PROVIDER_REJECTED, PermanentError, TransientError
from app.logs import get_logger

MAX_OUTPUT_TOKENS = 16384
MAX_IMAGES_PER_REQUEST = 8
IMAGES_DROPPED_HEADER = "x-evren-images-dropped"
CHAT_COMPLETIONS_PATH = "chat/completions"
IMAGE_DATA_URL_PREFIX = "data:image/"
CHAT_ROLES: tuple[str, ...] = ("assistant", "user")
TRANSIENT_STATUS_CODES: frozenset[int] = frozenset({408, 429})
REJECTED_STATUS_CODES: frozenset[int] = frozenset({400, 401, 403, 404, 422})

_TRANSPORT_ERRORS = (httpx.TimeoutException, httpx.TransportError)
_RETRY_AFTER_SECONDS = re.compile(r"[0-9]{1,10}")
_PROVIDER_TOKEN = re.compile(r"[A-Za-z0-9_.:\-]{1,64}")
_UNKNOWN_TOKEN = "-"
_LENGTH_FINISH_REASON = "length"
_MALFORMED_BODY_MESSAGE = "AI API yanıtının yapısı beklenen biçimde değil"
_log = get_logger("LlmClient")


class IncompleteOutputError(Exception):
    pass


class UnexpectedStatusError(Exception):
    # Sınıflandırılmamış durum kodunu saklar, hata metnine yalnızca bu kodu yazar.
    def __init__(self, status_code: int) -> None:
        super().__init__(f"AI API beklenmeyen HTTP {status_code} yanıtı verdi")
        self.status_code = status_code


@dataclass(frozen=True)
class LlmReply:
    content: str = field(repr=False)
    prompt_tokens: int | None
    completion_tokens: int | None


@dataclass(frozen=True)
class ChatTurn:
    role: Literal["assistant", "user"]
    text: str = field(repr=False)

    # Rolün assistant ya da user, metnin str olduğunu denetler.
    def __post_init__(self) -> None:
        if self.role not in CHAT_ROLES:
            raise ValueError("Sohbet turunun rolü assistant ya da user olmalı")
        if not isinstance(self.text, str):
            raise ValueError("Sohbet turunun metni str olmalı")


# Başlangıçtan bu yana geçen süreyi milisaniye olarak döndürür.
def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


# Görsel sayısını ve her değerin data:image/ ile başlayan bir metin olduğunu denetler.
def _check_images(image_data_urls: Sequence[str]) -> None:
    if len(image_data_urls) > MAX_IMAGES_PER_REQUEST:
        raise ValueError(
            f"İstek başına en fazla {MAX_IMAGES_PER_REQUEST} görsel gönderilebilir"
        )
    for url in image_data_urls:
        if not isinstance(url, str) or not url.startswith(IMAGE_DATA_URL_PREFIX):
            raise ValueError("Görseller data:image/ ile başlayan data URL olmalı")


# İç içe Mapping ve dizileri JSON'a yazılabilen sözlük ve listelere çevirir.
def _plain(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(item) for item in value]
    return value


# Gövdeyi JSON olarak çözer, çözülemezse None döndürür.
def _decode_json(content: bytes) -> object:
    try:
        return json.loads(content)
    except ValueError, RecursionError:
        return None


# Retry-After başlığı tam sayı saniyeyse değerini, değilse None döndürür.
def _retry_after_seconds(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    return int(text) if _RETRY_AFTER_SECONDS.fullmatch(text) else None


# Sağlayıcı değeri kısa ve güvenli bir belirteçse onu, değilse "-" döndürür.
def _provider_token(value: object) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if isinstance(value, str) and _PROVIDER_TOKEN.fullmatch(value):
        return value
    return _UNKNOWN_TOKEN


# Hata gövdesinden yalnızca sağlayıcının error.type ve error.code değerlerini alır.
def _provider_error(payload: object) -> tuple[str, str]:
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return _UNKNOWN_TOKEN, _UNKNOWN_TOKEN
    return _provider_token(error.get("type")), _provider_token(error.get("code"))


# usage içindeki değer negatif olmayan bir tam sayıysa onu, değilse None döndürür.
def _token_count(usage: object, name: str) -> int | None:
    value = usage.get(name) if isinstance(usage, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


# Yanıttaki choices[0] ve message nesnelerini döndürür, yapı bozuksa None verir.
def _first_choice(payload: object) -> tuple[dict[str, Any], dict[str, Any]] | None:
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, dict):
        return None
    message = choice.get("message")
    if not isinstance(message, dict):
        return None
    return choice, message


# Değer None ya da yalnızca boşluktan oluşan bir metinse True döndürür.
def _is_blank(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


class LlmClient:
    # Adresi ve zaman aşımı kurulu HTTP istemcisini, anahtarı ve model ayarını saklar.
    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        api_key: str,
        model: str,
        enable_thinking: bool,
    ) -> None:
        self._http = http
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._model = model
        self._enable_thinking = enable_thinking

    # Sohbet ucuna JSON şemalı istek gönderir, yanıtı sözleşme 8.4'e göre sınıflandırır.
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_text: str,
        image_data_urls: Sequence[str] = (),
        schema_name: str,
        schema: Mapping[str, object],
        follow_up: Sequence[ChatTurn] = (),
    ) -> LlmReply:
        _check_images(image_data_urls)
        body = self._build_body(
            system_prompt, user_text, image_data_urls, schema_name, schema, follow_up
        )
        started = time.monotonic()
        response = await self._send(body, started)
        status = response.status_code
        fields: dict[str, object] = {
            "model": self._model,
            "statusCode": status,
            "durationMs": _elapsed_ms(started),
        }
        payload = _decode_json(response.content)
        usage = (
            payload.get("usage")
            if status == 200 and isinstance(payload, dict)
            else None
        )
        prompt_tokens = _token_count(usage, "prompt_tokens")
        completion_tokens = _token_count(usage, "completion_tokens")
        self._log_response(fields, prompt_tokens, completion_tokens)
        if status != 200:
            raise self._status_failure(response, payload, fields) from None
        content = self._read_content(response, payload, fields)
        return LlmReply(content, prompt_tokens, completion_tokens)

    # Alttaki HTTP istemcisini ve bağlantılarını kapatır.
    async def aclose(self) -> None:
        await self._http.aclose()

    # Sözleşmedeki alanlar ve mesaj sırasıyla istek gövdesini kurar.
    def _build_body(
        self,
        system_prompt: str,
        user_text: str,
        image_data_urls: Sequence[str],
        schema_name: str,
        schema: Mapping[str, object],
        follow_up: Sequence[ChatTurn],
    ) -> dict[str, object]:
        user_content: list[dict[str, object]] = [{"type": "text", "text": user_text}]
        user_content.extend(
            {"type": "image_url", "image_url": {"url": url}} for url in image_data_urls
        )
        messages: list[dict[str, object]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        messages.extend({"role": turn.role, "content": turn.text} for turn in follow_up)
        return {
            "model": self._model,
            "stream": False,
            "temperature": 0,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "chat_template_kwargs": {"enable_thinking": self._enable_thinking},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name,
                    "strict": True,
                    "schema": _plain(schema),
                },
            },
            "messages": messages,
        }

    # İsteği gönderir; ağ, zaman aşımı ve gövde çözme hatalarını TransientError yapar.
    async def _send(self, body: dict[str, object], started: float) -> httpx.Response:
        try:
            return await self._http.post(
                CHAT_COMPLETIONS_PATH, json=body, headers=self._headers
            )
        except _TRANSPORT_ERRORS as error:
            failure = f"AI API'ye ulaşılamadı ({type(error).__name__})"
        except httpx.DecodingError:
            failure = _MALFORMED_BODY_MESSAGE
        _log.warning(
            failure, extra={"model": self._model, "durationMs": _elapsed_ms(started)}
        )
        raise TransientError(failure) from None

    # Yanıt alındığını model, durum kodu, süre ve varsa token sayılarıyla loglar.
    def _log_response(
        self,
        fields: dict[str, object],
        prompt_tokens: int | None,
        completion_tokens: int | None,
    ) -> None:
        extra = dict(fields)
        if prompt_tokens is not None:
            extra["promptTokens"] = prompt_tokens
        if completion_tokens is not None:
            extra["completionTokens"] = completion_tokens
        _log.info("AI API yanıtı alındı", extra=extra)

    # Başarısız durum kodunu geçici, kalıcı ya da bilinmeyen hataya çevirip loglar.
    def _status_failure(
        self, response: httpx.Response, payload: object, fields: dict[str, object]
    ) -> Exception:
        status = response.status_code
        if status in TRANSIENT_STATUS_CODES or 500 <= status <= 599:
            extra = dict(fields)
            retry_after = _retry_after_seconds(response.headers.get("retry-after"))
            if retry_after is not None:
                extra["retryAfterSeconds"] = retry_after
            _log.warning(
                "AI API geçici hata yanıtı verdi (HTTP %s)", status, extra=extra
            )
            return TransientError(f"AI API HTTP {status} yanıtı verdi")
        if status in REJECTED_STATUS_CODES:
            error_type, error_code = _provider_error(payload)
            _log.error(
                "AI API isteği reddetti (HTTP %s, type=%s, code=%s)",
                status,
                error_type,
                error_code,
                extra={**fields, "errorCode": AI_PROVIDER_REJECTED},
            )
            return PermanentError(AI_PROVIDER_REJECTED)
        _log.warning(
            "AI API beklenmeyen bir durum kodu döndürdü (HTTP %s)", status, extra=fields
        )
        return UnexpectedStatusError(status)

    # 200 yanıtını denetler; sorun yoksa modelin JSON metnini döndürür.
    def _read_content(
        self, response: httpx.Response, payload: object, fields: dict[str, object]
    ) -> str:
        rejected = {**fields, "errorCode": AI_PROVIDER_REJECTED}
        if IMAGES_DROPPED_HEADER in response.headers:
            _log.error("AI API görsellerin bir kısmını işlemeden attı", extra=rejected)
            raise PermanentError(AI_PROVIDER_REJECTED) from None
        parts = _first_choice(payload)
        content = parts[1].get("content") if parts is not None else None
        if parts is None or not (content is None or isinstance(content, str)):
            _log.warning(_MALFORMED_BODY_MESSAGE, extra=fields)
            raise TransientError(_MALFORMED_BODY_MESSAGE) from None
        choice, message = parts
        if not _is_blank(message.get("refusal")):
            _log.warning("Model isteği içerik gerekçesiyle reddetti", extra=rejected)
            raise PermanentError(AI_PROVIDER_REJECTED) from None
        if (
            not isinstance(content, str)
            or not content.strip()
            or choice.get("finish_reason") == _LENGTH_FINISH_REASON
        ):
            _log.warning("Model yanıtı yarım ya da boş geldi", extra=fields)
            raise IncompleteOutputError("Model yanıtı yarım ya da boş") from None
        return content


# Ayarlardaki adres, zaman aşımı, anahtar ve modelle tek bir AI API istemcisi kurar.
def create_llm_client(settings: Settings) -> LlmClient:
    http = httpx.AsyncClient(
        base_url=settings.ai_api_base_url.rstrip("/"),
        timeout=settings.ai_request_timeout_seconds,
    )
    return LlmClient(
        http,
        api_key=settings.ai_api_key.get_secret_value(),
        model=settings.ai_model,
        enable_thinking=settings.ai_enable_thinking,
    )
