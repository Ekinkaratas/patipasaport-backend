import json
import logging
import traceback
from collections.abc import AsyncIterator, Callable, Iterator
from types import MappingProxyType
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.errors import AI_PROVIDER_REJECTED, PermanentError, TransientError
from app.llm.client import (
    IMAGES_DROPPED_HEADER,
    MAX_IMAGES_PER_REQUEST,
    MAX_OUTPUT_TOKENS,
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    LlmReply,
    UnexpectedStatusError,
    create_llm_client,
)
from app.logs import JsonFormatter

BASE_URL = "http://ai.invalid/v1"
ENDPOINT = f"{BASE_URL}/chat/completions"
FAKE_API_KEY = "SAHTE-AI-ANAHTARI-8M"
MODEL = "sahte-model"
LLM_LOGGER = "LlmClient"
MALFORMED_MESSAGE = "AI API yanıtının yapısı beklenen biçimde değil"
BROKEN_GZIP_BODY = b"gzip-olmayan-bozuk-govde"
CONTENT_MARKER = "GIZLI-ICERIK-4P"
REASONING_MARKER = "GIZLI-DUSUNME-6T"
REFUSAL_MARKER = "GIZLI-RET-5K"
PROVIDER_MESSAGE_MARKER = "YANSIYAN-GIRDI-2W"
USAGE_EXTRA_MARKER = "EVREN-KULLANIM-9Q"
SYSTEM_MARKER = "SISTEM-TALIMATI-1A"
USER_MARKER = "GOREV-METNI-3B"
IMAGE_MARKER = "GORSELVERISI7Y"
SYSTEM_PROMPT = f"{SYSTEM_MARKER} sistem talimatı"
USER_TEXT = f"{USER_MARKER} görev metni"
CONTENT = json.dumps({"isMedicalDocument": True, "notes": CONTENT_MARKER})
SCHEMA_NAME = "record_content"
SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "isMedicalDocument": {"type": "boolean"},
        "notes": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
    "required": ["isMedicalDocument", "notes"],
    "additionalProperties": False,
}
IMAGES = (
    f"data:image/jpeg;base64,{IMAGE_MARKER}1",
    f"data:image/png;base64,{IMAGE_MARKER}2",
    f"data:image/jpeg;base64,{IMAGE_MARKER}3",
)
FOLLOW_UP = (
    ChatTurn("assistant", f"{CONTENT_MARKER} önceki çıktı"),
    ChatTurn("user", "düzeltme metni"),
)
PROMPT_TOKENS = 120
COMPLETION_TOKENS = 45
DEFAULT_USAGE: dict[str, Any] = {
    "prompt_tokens": PROMPT_TOKENS,
    "completion_tokens": COMPLETION_TOKENS,
    "total_tokens": PROMPT_TOKENS + COMPLETION_TOKENS,
    "evren": {"not": USAGE_EXTRA_MARKER},
}
FORBIDDEN_TEXTS = (
    FAKE_API_KEY,
    CONTENT_MARKER,
    REASONING_MARKER,
    REFUSAL_MARKER,
    PROVIDER_MESSAGE_MARKER,
    USAGE_EXTRA_MARKER,
    SYSTEM_MARKER,
    USER_MARKER,
    IMAGE_MARKER,
)
_MISSING = object()

Responder = Callable[[httpx.Request], httpx.Response]


class Recorder:
    # Gelen istekleri kaydeden ve her istekte verilen yanıtı üreten sahte uç kurar.
    def __init__(self, respond: Responder) -> None:
        self.respond = respond
        self.requests: list[httpx.Request] = []

    # İsteği kaydeder ve tanımlı yanıtı ya da hatayı üretir.
    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


# Verilen içerik, bitiş nedeni, ret ve usage ile bir sohbet yanıtı gövdesi kurar.
def completion(
    content: object = CONTENT,
    *,
    finish_reason: str = "stop",
    refusal: object = None,
    usage: object = DEFAULT_USAGE,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": "chatcmpl-sahte",
        "object": "chat.completion",
        "model": "google/sahte-model",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "reasoning": f"{REASONING_MARKER} düşünme metni",
                    "refusal": refusal,
                },
            }
        ],
    }
    if usage is not _MISSING:
        body["usage"] = usage
    return body


# Verilen gövdeyi JSON olarak döndüren bir yanıt üreticisi kurar.
def respond_json(
    body: object, status: int = 200, headers: dict[str, str] | None = None
) -> Responder:
    # Her istekte aynı JSON yanıtı üretir.
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers)

    return respond


# Verilen ham gövdeyi döndüren bir yanıt üreticisi kurar.
def respond_raw(
    content: bytes, status: int = 200, headers: dict[str, str] | None = None
) -> Responder:
    # Her istekte aynı ham yanıtı üretir.
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=content, headers=headers)

    return respond


# Sağlayıcının hata gövdesini verilen tür ve kodla, girdiyi yansıtan mesajla kurar.
def provider_error(error_type: object, code: object) -> dict[str, Any]:
    return {
        "error": {
            "message": f"{PROVIDER_MESSAGE_MARKER} isteği yansıtan mesaj",
            "type": error_type,
            "param": None,
            "code": code,
        }
    }


# Sahte değerlerle, gerçek .env dosyasını okumadan ayarları kurar.
def fake_settings(
    base_url: str = BASE_URL, timeout: float = 45.5, enable_thinking: bool = False
) -> Settings:
    return Settings(
        _env_file=None,
        rabbitmq_host="rabbitmq.invalid",
        rabbitmq_port=5672,
        ai_rabbitmq_user="ai",
        ai_rabbitmq_password="sahte-rabbitmq-sifresi",
        s3_endpoint="http://depo.invalid:8333",
        s3_bucket="medical-documents",
        s3_access_key="sahte-erisim-anahtari",
        s3_secret_key="sahte-gizli-anahtar",
        ai_api_base_url=base_url,
        ai_api_key=FAKE_API_KEY,
        ai_model=MODEL,
        ai_request_timeout_seconds=timeout,
        ai_enable_thinking=enable_thinking,
        log_level="INFO",
    )


# Kaydın JSON log satırını, mesajını ve tüm özniteliklerini tek metinde birleştirir.
def render_record(record: logging.LogRecord) -> str:
    values = " ".join(map(str, vars(record).values()))
    return " ".join([JsonFormatter().format(record), record.getMessage(), values])


# LlmClient loglarını yakalatır, test sonunda kayıtlarda yasaklı metin olmadığını sınar.
@pytest.fixture(autouse=True)
def clean_logs(caplog: pytest.LogCaptureFixture) -> Iterator[None]:
    caplog.set_level(logging.DEBUG, logger=LLM_LOGGER)
    yield
    for record in caplog.get_records("call"):
        rendered = render_record(record)
        for text in FORBIDDEN_TEXTS:
            assert text not in rendered
        if record.name == LLM_LOGGER:
            assert record.exc_info is None


# Testte kurulan istemcileri sonunda kapatan bir LlmClient fabrikası verir.
@pytest.fixture
async def make_client() -> AsyncIterator[Callable[..., tuple[LlmClient, Recorder]]]:
    created: list[LlmClient] = []

    # Sahte uca bağlı, verilen düşünme ayarıyla bir istemci ve kaydedici kurar.
    def factory(
        respond: Responder, *, enable_thinking: bool = True
    ) -> tuple[LlmClient, Recorder]:
        recorder = Recorder(respond)
        http = httpx.AsyncClient(
            base_url=BASE_URL, transport=httpx.MockTransport(recorder)
        )
        client = LlmClient(
            http, api_key=FAKE_API_KEY, model=MODEL, enable_thinking=enable_thinking
        )
        created.append(client)
        return client, recorder

    yield factory
    for client in created:
        await client.aclose()


# İstemciyi varsayılan talimat, görev metni ve şemayla, verilen ek alanlarla çağırır.
async def call(client: LlmClient, **overrides: Any) -> LlmReply:
    arguments: dict[str, Any] = {
        "system_prompt": SYSTEM_PROMPT,
        "user_text": USER_TEXT,
        "schema_name": SCHEMA_NAME,
        "schema": SCHEMA,
    }
    arguments.update(overrides)
    return await client.complete_json(**arguments)


# LlmClient kayıtlarını döndürür.
def client_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == LLM_LOGGER]


# Hatanın zincirsiz olduğunu, metninde ve izinde yasaklı metin olmadığını sınar.
def assert_clean_error(error: BaseException) -> None:
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error)) + repr(error) + str(error)
    for text in FORBIDDEN_TEXTS:
        assert text not in rendered


# Yanıt kaydının model, durum kodu ve süre taşıyan bir info kaydı olduğunu sınar.
def assert_response_record(record: logging.LogRecord, status: int) -> None:
    assert record.levelno == logging.INFO
    assert getattr(record, "model", None) == MODEL
    assert getattr(record, "statusCode", None) == status
    assert isinstance(getattr(record, "durationMs", None), int)


# Kaydın verilen seviyede, durum kodu ve hata koduyla yazıldığını sınar.
def assert_failure_record(
    record: logging.LogRecord, level: int, status: int, error_code: str | None
) -> None:
    assert record.levelno == level
    assert getattr(record, "model", None) == MODEL
    assert getattr(record, "statusCode", None) == status
    assert isinstance(getattr(record, "durationMs", None), int)
    assert getattr(record, "errorCode", None) == error_code
    assert not hasattr(record, "retryAfterSeconds")


# Sözleşmedeki sabitlerin değerlerini doğrular.
def test_constants_match_contract() -> None:
    assert MAX_OUTPUT_TOKENS == 16384
    assert MAX_IMAGES_PER_REQUEST == 8
    assert IMAGES_DROPPED_HEADER == "x-evren-images-dropped"


# İsteğin sohbet ucuna POST olarak, Bearer anahtar ve JSON türüyle gittiğini sınar.
async def test_request_targets_chat_completions_with_bearer_key(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
) -> None:
    client, recorder = make_client(respond_json(completion()))

    await call(client)

    [request] = recorder.requests
    assert request.method == "POST"
    assert str(request.url) == ENDPOINT
    assert request.headers["authorization"] == f"Bearer {FAKE_API_KEY}"
    assert request.headers["content-type"] == "application/json"


# Gövdenin alanlarını, görsel ve ek tur sırasını ve düşünme ayarını birebir sınar.
@pytest.mark.parametrize(
    "enable_thinking",
    [pytest.param(True, id="dusunme-acik"), pytest.param(False, id="dusunme-kapali")],
)
async def test_request_body_matches_contract(
    make_client: Callable[..., tuple[LlmClient, Recorder]], enable_thinking: bool
) -> None:
    client, recorder = make_client(
        respond_json(completion()), enable_thinking=enable_thinking
    )

    await call(client, image_data_urls=IMAGES, follow_up=FOLLOW_UP)

    [request] = recorder.requests
    body = json.loads(request.content)
    assert body == {
        "model": MODEL,
        "stream": False,
        "temperature": 0,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "chat_template_kwargs": {"enable_thinking": enable_thinking},
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": SCHEMA_NAME, "strict": True, "schema": SCHEMA},
        },
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_TEXT},
                    {"type": "image_url", "image_url": {"url": IMAGES[0]}},
                    {"type": "image_url", "image_url": {"url": IMAGES[1]}},
                    {"type": "image_url", "image_url": {"url": IMAGES[2]}},
                ],
            },
            {"role": "assistant", "content": FOLLOW_UP[0].text},
            {"role": "user", "content": FOLLOW_UP[1].text},
        ],
    }
    assert body["stream"] is False
    assert body["temperature"] == 0 and isinstance(body["temperature"], int)
    assert body["chat_template_kwargs"]["enable_thinking"] is enable_thinking
    assert body["response_format"]["json_schema"]["strict"] is True
    assert "reasoning_effort" not in body


# Görsel ve ek tur yokken yalnızca sistem ve metinli kullanıcı mesajı gittiğini sınar.
async def test_request_without_images_has_text_only_user_message(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
) -> None:
    client, recorder = make_client(respond_json(completion()))

    await call(client)

    [request] = recorder.requests
    assert json.loads(request.content)["messages"] == [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": [{"type": "text", "text": USER_TEXT}]},
    ]


# Mapping türündeki iç içe şemanın sözlük olarak gönderildiğini sınar.
async def test_mapping_schema_is_sent_as_plain_json(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
) -> None:
    client, recorder = make_client(respond_json(completion()))
    schema = MappingProxyType(
        {
            "type": "object",
            "properties": MappingProxyType({"a": MappingProxyType({"type": "string"})}),
            "required": ("a",),
        }
    )

    await call(client, schema=schema)

    [request] = recorder.requests
    sent = json.loads(request.content)["response_format"]["json_schema"]["schema"]
    assert sent == {
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "required": ["a"],
    }


# Tam sekiz görselin kabul edilip sırasıyla gönderildiğini sınar.
async def test_eight_images_are_sent(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
) -> None:
    client, recorder = make_client(respond_json(completion()))
    images = tuple(f"data:image/jpeg;base64,QQ{index}=" for index in range(8))

    await call(client, image_data_urls=images)

    [request] = recorder.requests
    user_content = json.loads(request.content)["messages"][1]["content"]
    assert [part["image_url"]["url"] for part in user_content[1:]] == list(images)


# Sekizden fazla görselde istek gönderilmeden ValueError verildiğini sınar.
async def test_more_than_eight_images_raise_without_request(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, recorder = make_client(respond_json(completion()))
    images = tuple(f"data:image/jpeg;base64,QQ{index}=" for index in range(9))

    with pytest.raises(ValueError):
        await call(client, image_data_urls=images)

    assert recorder.requests == []
    assert client_records(caplog) == []


# data:image/ ile başlamayan görsellerde istek gitmeden ValueError verildiğini sınar.
@pytest.mark.parametrize(
    "value",
    [
        pytest.param("https://ornek.invalid/sayfa.jpg", id="http-adresi"),
        pytest.param("data:application/pdf;base64,QQ==", id="pdf-data-url"),
        pytest.param("DATA:IMAGE/png;base64,QQ==", id="buyuk-harf"),
        pytest.param(" data:image/png;base64,QQ==", id="bosluklu"),
        pytest.param("", id="bos"),
        pytest.param(b"data:image/png;base64,QQ==", id="bayt"),
        pytest.param(None, id="none"),
    ],
)
async def test_non_data_url_images_raise_without_request(
    make_client: Callable[..., tuple[LlmClient, Recorder]], value: object
) -> None:
    client, recorder = make_client(respond_json(completion()))

    with pytest.raises(ValueError):
        await call(client, image_data_urls=(IMAGES[0], value))

    assert recorder.requests == []


# Sohbet turunun geçersiz rolü ve metin olmayan değeri reddettiğini sınar.
@pytest.mark.parametrize(
    ("role", "text"),
    [
        pytest.param("system", "metin", id="system-rolu"),
        pytest.param("tool", "metin", id="tool-rolu"),
        pytest.param("user", None, id="metin-yok"),
        pytest.param("assistant", b"metin", id="bayt-metin"),
    ],
)
def test_chat_turn_rejects_invalid_values(role: Any, text: Any) -> None:
    with pytest.raises(ValueError):
        ChatTurn(role, text)


# Yanıt ve sohbet turu temsillerinin model çıktısını içermediğini sınar.
def test_reply_and_turn_repr_hide_text() -> None:
    reply = LlmReply(CONTENT, PROMPT_TOKENS, COMPLETION_TOKENS)

    assert CONTENT_MARKER not in repr(reply)
    assert CONTENT_MARKER not in repr(FOLLOW_UP[0])


# Başarılı yanıtta içerik ve token sayılarının döndüğünü ve info logunu sınar.
async def test_successful_reply_returns_content_and_tokens(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, _ = make_client(respond_json(completion(refusal="")))

    reply = await call(client)

    assert reply == LlmReply(CONTENT, PROMPT_TOKENS, COMPLETION_TOKENS)
    [record] = client_records(caplog)
    assert_response_record(record, 200)
    assert getattr(record, "promptTokens", None) == PROMPT_TOKENS
    assert getattr(record, "completionTokens", None) == COMPLETION_TOKENS
    assert not hasattr(record, "errorCode")


# usage yoksa ya da geçersizse token sayılarının None olup loglanmadığını sınar.
@pytest.mark.parametrize(
    "usage",
    [
        pytest.param(_MISSING, id="usage-yok"),
        pytest.param(None, id="usage-null"),
        pytest.param("120", id="usage-metin"),
        pytest.param({}, id="usage-bos"),
        pytest.param(
            {"prompt_tokens": "120", "completion_tokens": "45"}, id="metin-sayilar"
        ),
        pytest.param(
            {"prompt_tokens": True, "completion_tokens": False}, id="mantiksal"
        ),
        pytest.param({"prompt_tokens": 1.5, "completion_tokens": -3}, id="kesirli"),
    ],
)
async def test_missing_or_invalid_usage_gives_none(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    usage: object,
) -> None:
    client, _ = make_client(respond_json(completion(usage=usage)))

    reply = await call(client)

    assert reply == LlmReply(CONTENT, None, None)
    [record] = client_records(caplog)
    assert_response_record(record, 200)
    assert not hasattr(record, "promptTokens")
    assert not hasattr(record, "completionTokens")


# Boş, null ya da length ile kesilen çıktının IncompleteOutputError verdiğini sınar.
@pytest.mark.parametrize(
    ("content", "finish_reason"),
    [
        pytest.param(None, "stop", id="content-null"),
        pytest.param("", "stop", id="content-bos"),
        pytest.param(" \n\t", "stop", id="content-bosluk"),
        pytest.param(None, "length", id="null-ve-length"),
        pytest.param(CONTENT, "length", id="kesilmis-icerik"),
    ],
)
async def test_empty_or_truncated_output_is_incomplete(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    content: object,
    finish_reason: str,
) -> None:
    client, _ = make_client(
        respond_json(completion(content, finish_reason=finish_reason))
    )

    with pytest.raises(IncompleteOutputError) as raised:
        await call(client)

    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, 200)
    assert getattr(response_record, "promptTokens", None) == PROMPT_TOKENS
    assert_failure_record(failure_record, logging.WARNING, 200, None)


# Modelin içerik reddinde AI_PROVIDER_REJECTED verildiğini sınar.
@pytest.mark.parametrize(
    "content",
    [pytest.param(None, id="content-null"), pytest.param(CONTENT, id="content-dolu")],
)
async def test_refusal_is_provider_rejected(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    content: object,
) -> None:
    client, _ = make_client(
        respond_json(completion(content, refusal=f"{REFUSAL_MARKER} reddediyorum"))
    )

    with pytest.raises(PermanentError) as raised:
        await call(client)

    assert raised.value.code == AI_PROVIDER_REJECTED
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, 200)
    assert_failure_record(failure_record, logging.WARNING, 200, AI_PROVIDER_REJECTED)


# Görsel atıldı başlığının AI_PROVIDER_REJECTED ve error logu verdiğini sınar.
async def test_images_dropped_header_is_provider_rejected(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, _ = make_client(
        respond_json(completion(), headers={IMAGES_DROPPED_HEADER: "1"})
    )

    with pytest.raises(PermanentError) as raised:
        await call(client, image_data_urls=IMAGES)

    assert raised.value.code == AI_PROVIDER_REJECTED
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, 200)
    assert_failure_record(failure_record, logging.ERROR, 200, AI_PROVIDER_REJECTED)


# 400/401/403/404/422 yanıtlarında AI_PROVIDER_REJECTED ve tür-kod logunu sınar.
@pytest.mark.parametrize(
    ("status", "error_type", "code", "expected_code"),
    [
        pytest.param(400, "invalid_request_error", None, "-", id="400"),
        pytest.param(401, "authentication_error", None, "-", id="401"),
        pytest.param(403, "permission_error", "forbidden", "forbidden", id="403"),
        pytest.param(
            404, "invalid_request_error", "model_not_found", "model_not_found", id="404"
        ),
        pytest.param(422, "invalid_request_error", 422, "422", id="422"),
    ],
)
async def test_rejected_statuses_are_provider_rejected(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    status: int,
    error_type: str,
    code: object,
    expected_code: str,
) -> None:
    client, _ = make_client(respond_json(provider_error(error_type, code), status))

    with pytest.raises(PermanentError) as raised:
        await call(client)

    assert raised.value.code == AI_PROVIDER_REJECTED
    assert str(raised.value) == AI_PROVIDER_REJECTED
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, status)
    assert not hasattr(response_record, "promptTokens")
    assert_failure_record(failure_record, logging.ERROR, status, AI_PROVIDER_REJECTED)
    message = failure_record.getMessage()
    assert f"HTTP {status}" in message
    assert f"type={error_type}" in message
    assert f"code={expected_code}" in message


# Ret gövdesinde güvenli tür ve kod yoksa loga yerlerine "-" yazıldığını sınar.
@pytest.mark.parametrize(
    "respond",
    [
        pytest.param(respond_raw(b"<html>hata</html>", 400), id="json-degil"),
        pytest.param(respond_json({"error": "metin"}, 400), id="error-metin"),
        pytest.param(
            respond_json(
                provider_error(f"tür {PROVIDER_MESSAGE_MARKER}", "x" * 65), 400
            ),
            id="guvensiz-tur-ve-kod",
        ),
        pytest.param(
            respond_json(provider_error(["liste"], True), 400), id="metin-olmayan"
        ),
    ],
)
async def test_rejected_without_safe_details_logs_placeholders(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    respond: Responder,
) -> None:
    client, _ = make_client(respond)

    with pytest.raises(PermanentError) as raised:
        await call(client)

    assert raised.value.code == AI_PROVIDER_REJECTED
    _, failure_record = client_records(caplog)
    assert "type=-, code=-" in failure_record.getMessage()


# 408/429/500/503 yanıtlarının Retry-After alanı olmadan TransientError verdiğini sınar.
@pytest.mark.parametrize("status", [408, 429, 500, 503])
async def test_transient_statuses_raise_transient_error(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    status: int,
) -> None:
    client, _ = make_client(respond_json(provider_error("server_error", None), status))

    with pytest.raises(TransientError) as raised:
        await call(client)

    assert str(status) in str(raised.value)
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, status)
    assert_failure_record(failure_record, logging.WARNING, status, None)


# Yalnızca tam sayı saniyeli Retry-After'ın retryAfterSeconds yazdırdığını sınar.
@pytest.mark.parametrize(
    ("status", "header", "expected"),
    [
        pytest.param(429, "7", 7, id="429-tam-sayi"),
        pytest.param(503, "120", 120, id="503-tam-sayi"),
        pytest.param(429, "0", 0, id="sifir"),
        pytest.param(429, "Mon, 26 Oct 2026 07:28:00 GMT", None, id="tarih"),
        pytest.param(503, "1.5", None, id="kesirli"),
        pytest.param(429, "-3", None, id="negatif"),
        pytest.param(429, "", None, id="bos"),
    ],
)
async def test_retry_after_is_logged_only_when_integer(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    status: int,
    header: str,
    expected: int | None,
) -> None:
    client, _ = make_client(
        respond_json(
            provider_error("rate_limit", None), status, {"Retry-After": header}
        )
    )

    with pytest.raises(TransientError):
        await call(client)

    _, failure_record = client_records(caplog)
    assert failure_record.levelno == logging.WARNING
    assert getattr(failure_record, "retryAfterSeconds", None) == expected
    assert hasattr(failure_record, "retryAfterSeconds") is (expected is not None)


# Zaman aşımı ve bağlantı hatalarının zincirsiz TransientError'a çevrildiğini sınar.
@pytest.mark.parametrize(
    "error_type",
    [
        pytest.param(httpx.ReadTimeout, id="read-timeout"),
        pytest.param(httpx.ConnectTimeout, id="connect-timeout"),
        pytest.param(httpx.PoolTimeout, id="pool-timeout"),
        pytest.param(httpx.ConnectError, id="connect-error"),
        pytest.param(httpx.RemoteProtocolError, id="protocol-error"),
        pytest.param(httpx.ReadError, id="read-error"),
    ],
)
async def test_transport_errors_raise_transient_error(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    error_type: type[httpx.TransportError],
) -> None:
    # İsteği taşıyan ve mesajında anahtarı geçiren bir aktarım hatası fırlatır.
    def fail(request: httpx.Request) -> httpx.Response:
        raise error_type(f"aktarım hatası {FAKE_API_KEY}", request=request)

    client, recorder = make_client(fail)

    with pytest.raises(TransientError) as raised:
        await call(client)

    assert len(recorder.requests) == 1
    assert error_type.__name__ in str(raised.value)
    assert_clean_error(raised.value)
    [record] = client_records(caplog)
    assert record.levelno == logging.WARNING
    assert getattr(record, "model", None) == MODEL
    assert isinstance(getattr(record, "durationMs", None), int)
    assert not hasattr(record, "statusCode")
    assert error_type.__name__ in record.getMessage()


# Gzip olarak bildirilen ama çözülemeyen bir gövdeyi akış olarak döndürür.
def respond_broken_gzip_stream(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"Content-Encoding": "gzip"},
        stream=httpx.ByteStream(BROKEN_GZIP_BODY),
    )


# İsteği taşıyan ve mesajında anahtarı geçiren bir gövde çözme hatası fırlatır.
def raise_decoding_error(request: httpx.Request) -> httpx.Response:
    raise httpx.DecodingError(f"çözme hatası {FAKE_API_KEY}", request=request)


# Çözülemeyen sıkıştırılmış gövdenin zincirsiz TransientError verdiğini sınar.
@pytest.mark.parametrize(
    "respond",
    [
        pytest.param(respond_broken_gzip_stream, id="gzip-akis"),
        pytest.param(
            respond_raw(BROKEN_GZIP_BODY, 200, {"Content-Encoding": "gzip"}),
            id="gzip-govde",
        ),
        pytest.param(
            respond_raw(BROKEN_GZIP_BODY, 503, {"Content-Encoding": "gzip"}),
            id="gzip-503",
        ),
        pytest.param(raise_decoding_error, id="anahtarli-mesaj"),
    ],
)
async def test_decoding_error_raises_transient_error(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    respond: Responder,
) -> None:
    client, recorder = make_client(respond)

    with pytest.raises(TransientError) as raised:
        await call(client)

    assert len(recorder.requests) == 1
    assert str(raised.value) == MALFORMED_MESSAGE
    assert_clean_error(raised.value)
    [record] = client_records(caplog)
    assert record.levelno == logging.WARNING
    assert record.getMessage() == MALFORMED_MESSAGE
    assert getattr(record, "model", None) == MODEL
    assert isinstance(getattr(record, "durationMs", None), int)
    assert not hasattr(record, "statusCode")
    assert not hasattr(record, "errorCode")


# JSON olmayan ya da yapısı bozuk 200 yanıtlarının TransientError verdiğini sınar.
@pytest.mark.parametrize(
    "respond",
    [
        pytest.param(respond_raw(b"<html>bakim</html>"), id="html"),
        pytest.param(respond_raw(b""), id="bos-govde"),
        pytest.param(respond_raw(b'{"choices": ['), id="yarim-json"),
        pytest.param(respond_raw(b"null"), id="json-null"),
        pytest.param(respond_json([completion()]), id="json-liste"),
        pytest.param(respond_json({}), id="choices-yok"),
        pytest.param(respond_json({"choices": []}), id="choices-bos"),
        pytest.param(respond_json({"choices": "x"}), id="choices-metin"),
        pytest.param(respond_json({"choices": ["x"]}), id="secenek-metin"),
        pytest.param(respond_json({"choices": [{}]}), id="message-yok"),
        pytest.param(respond_json({"choices": [{"message": None}]}), id="message-null"),
        pytest.param(
            respond_json(completion([{"type": "text", "text": CONTENT}])),
            id="content-liste",
        ),
        pytest.param(respond_json(completion(42)), id="content-sayi"),
    ],
)
async def test_malformed_success_body_raises_transient_error(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    respond: Responder,
) -> None:
    client, _ = make_client(respond)

    with pytest.raises(TransientError) as raised:
        await call(client)

    assert str(raised.value) == MALFORMED_MESSAGE
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, 200)
    assert_failure_record(failure_record, logging.WARNING, 200, None)
    assert failure_record.getMessage() == MALFORMED_MESSAGE


# Sınıflandırılmamış durum kodlarının UnexpectedStatusError verdiğini sınar.
@pytest.mark.parametrize("status", [409, 201, 302, 418])
async def test_unclassified_status_raises_unexpected_status_error(
    make_client: Callable[..., tuple[LlmClient, Recorder]],
    caplog: pytest.LogCaptureFixture,
    status: int,
) -> None:
    client, _ = make_client(
        respond_json(provider_error("conflict", None), status, {"Retry-After": "5"})
    )

    with pytest.raises(UnexpectedStatusError) as raised:
        await call(client)

    assert raised.value.status_code == status
    assert str(status) in str(raised.value)
    assert not isinstance(raised.value, TransientError | PermanentError)
    assert_clean_error(raised.value)
    response_record, failure_record = client_records(caplog)
    assert_response_record(response_record, status)
    assert_failure_record(failure_record, logging.WARNING, status, None)


# create_llm_client'ın adres, "/" birleşimi, zaman aşımı ve anahtarı kurduğunu sınar.
@pytest.mark.parametrize(
    ("base_url", "expected_url"),
    [
        pytest.param(BASE_URL, ENDPOINT, id="sondaki-bolu-yok"),
        pytest.param(f"{BASE_URL}/", ENDPOINT, id="sondaki-bolu"),
        pytest.param(f"{BASE_URL}//", ENDPOINT, id="cift-bolu"),
        pytest.param(
            "http://ai.invalid", "http://ai.invalid/chat/completions", id="yolsuz"
        ),
    ],
)
async def test_create_llm_client_builds_endpoint_and_timeout(
    monkeypatch: pytest.MonkeyPatch, base_url: str, expected_url: str
) -> None:
    recorder = Recorder(respond_json(completion()))
    real_client = httpx.AsyncClient
    created: list[tuple[dict[str, Any], httpx.AsyncClient]] = []

    # Gerçek istemciyi aynı parametreler ve sahte uçla kurar, parametreleri kaydeder.
    def build(**kwargs: Any) -> httpx.AsyncClient:
        http = real_client(transport=httpx.MockTransport(recorder), **kwargs)
        created.append((kwargs, http))
        return http

    monkeypatch.setattr(httpx, "AsyncClient", build)
    client = create_llm_client(fake_settings(base_url, 45.5, enable_thinking=False))
    try:
        reply = await call(client)
    finally:
        await client.aclose()

    [(kwargs, http)] = created
    assert set(kwargs) == {"base_url", "timeout"}
    assert kwargs["timeout"] == 45.5
    assert http.timeout == httpx.Timeout(45.5)
    assert http.is_closed
    assert reply.content == CONTENT
    [request] = recorder.requests
    assert str(request.url) == expected_url
    assert request.headers["authorization"] == f"Bearer {FAKE_API_KEY}"
    body = json.loads(request.content)
    assert body["model"] == MODEL
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


# create_llm_client'ın düşünme ayarını gövdeye taşıdığını sınar.
async def test_create_llm_client_passes_enable_thinking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = Recorder(respond_json(completion()))
    real_client = httpx.AsyncClient

    # Gerçek istemciyi aynı parametreler ve sahte uçla kurar.
    def build(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(recorder), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", build)
    client = create_llm_client(fake_settings(enable_thinking=True))
    try:
        await call(client)
    finally:
        await client.aclose()

    [request] = recorder.requests
    body = json.loads(request.content)
    assert body["chat_template_kwargs"] == {"enable_thinking": True}
