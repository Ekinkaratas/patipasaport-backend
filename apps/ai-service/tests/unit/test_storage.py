import hashlib
import logging
import threading
import traceback
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from boto3.session import Session
from botocore.awsrequest import AWSPreparedRequest, AWSResponse
from botocore.client import BaseClient
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    IncompleteReadError,
    ReadTimeoutError,
    ResponseStreamingError,
)
from botocore.stub import Stubber

from app import storage as storage_module
from app.config import Settings
from app.errors import (
    FILE_INTEGRITY_ERROR,
    FILE_NOT_FOUND,
    PermanentError,
    TransientError,
)
from app.storage import S3_REGION, DocumentStorage, create_storage

BUCKET = "medical-documents"
KEY = "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f.pdf"
ENDPOINT = "http://depo.invalid:8333"
ENDPOINT_WITH_KEY = f"{ENDPOINT}/{BUCKET}/{KEY}"
BODY_MARKER = "GIZLI-GOVDE-7Q"
BODY = f"%PDF-1.7 {BODY_MARKER}".encode()
BODY_SHA256 = hashlib.sha256(BODY).hexdigest()
OTHER_SHA256 = hashlib.sha256(b"baska-icerik").hexdigest()
FAKE_ACCESS_KEY = "SAHTE-ERISIM-ANAHTARI-3K"
FAKE_SECRET_KEY = "SAHTE-GIZLI-ANAHTAR-9Z"
FORBIDDEN_TEXTS = (KEY, BODY_MARKER, FAKE_ACCESS_KEY, FAKE_SECRET_KEY)
EXPECTED_PARAMS = {"Bucket": BUCKET, "Key": KEY}
STORAGE_LOGGER = "Storage"


class FakeBody:
    # Okununca veriyi ya da verilen hatayı döndüren, çağrıları sayan sahte akış kurar.
    def __init__(self, data: bytes = BODY, error: Exception | None = None) -> None:
        self.data = data
        self.error = error
        self.read_calls = 0
        self.closed = False

    # Okuma çağrısını sayar; hata tanımlıysa fırlatır, yoksa kalan veriyi döndürür.
    def read(self, amt: int | None = None) -> bytes:
        self.read_calls += 1
        if self.error is not None:
            raise self.error
        data, self.data = self.data, b""
        return data

    # Akışın kapatıldığını kaydeder.
    def close(self) -> None:
        self.closed = True


class FakeClient:
    # get_object çağrılarını kaydeden, verilen hatayı fırlatan sahte istemci kurar.
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []
        self.thread_ids: list[int] = []

    # Çağrıyı ve iş parçacığını kaydeder; hata varsa fırlatır, yoksa gövdeyi verir.
    def get_object(self, **params: Any) -> dict[str, Any]:
        self.calls.append(params)
        self.thread_ids.append(threading.get_ident())
        if self.error is not None:
            raise self.error
        return {"Body": FakeBody(), "ContentLength": len(BODY)}


# Testleri kullanıcının AWS yapılandırma dosyalarından ve profilinden yalıtır.
@pytest.fixture(autouse=True)
def isolated_aws_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "aws-config-yok"))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "aws-kimlik-yok"))
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_PROFILE", raising=False)


# Storage logger'ının DEBUG dahil tüm kayıtlarını yakalatır.
@pytest.fixture(autouse=True)
def storage_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger=STORAGE_LOGGER)


# Sahte anahtarlarla, Stubber'la ağa çıkmadan kullanılacak gerçek S3 istemcisi kurar.
def make_client() -> BaseClient:
    return Session().client(
        "s3",
        endpoint_url=ENDPOINT,
        region_name=S3_REGION,
        aws_access_key_id=FAKE_ACCESS_KEY,
        aws_secret_access_key=FAKE_SECRET_KEY,
    )


# Gerçek istemciyi Stubber'la sarar ve test sonunda bekleyen yanıt kalmadığını doğrular.
@pytest.fixture
def stubbed() -> Iterator[tuple[DocumentStorage, Stubber]]:
    client = make_client()
    with Stubber(client) as stubber:
        yield DocumentStorage(client, BUCKET), stubber
        stubber.assert_no_pending_responses()


# Sahte istemciyi DocumentStorage'ın beklediği istemci türüne çevirip depo kurar.
def fake_storage(client: FakeClient) -> DocumentStorage:
    return DocumentStorage(cast(BaseClient, client), BUCKET)


# Sahte değerlerle, gerçek .env dosyasını okumadan ayarları kurar.
def fake_settings() -> Settings:
    return Settings(
        _env_file=None,
        rabbitmq_host="rabbitmq.invalid",
        ai_rabbitmq_user="ai",
        ai_rabbitmq_password="sahte-rabbitmq-sifresi",
        s3_endpoint=ENDPOINT,
        s3_bucket=BUCKET,
        s3_access_key=FAKE_ACCESS_KEY,
        s3_secret_key=FAKE_SECRET_KEY,
        ai_api_base_url="http://ai.invalid",
        ai_api_key="sahte-ai-anahtari",
        ai_model="sahte-model",
    )


# Stubber'a beklenen parametrelerle verilen gövdeyi ve boyutu döndüren yanıt ekler.
def add_object(stubber: Stubber, body: FakeBody, content_length: int | None) -> None:
    response: dict[str, Any] = {"Body": body}
    if content_length is not None:
        response["ContentLength"] = content_length
    stubber.add_response("get_object", response, EXPECTED_PARAMS)


# Stubber'a hata metninde anahtarı taşıyan bir depo hata yanıtı ekler.
def add_error(stubber: Stubber, code: str, status: int) -> None:
    stubber.add_client_error(
        "get_object",
        service_error_code=code,
        service_message=f"Depo hatası: {KEY}",
        http_status_code=status,
        expected_params=EXPECTED_PARAMS,
    )


# Anahtarı ve sahte gövdeyi taşıyan, verilen durumda bir ClientError üretir.
def client_error(code: str, status: int) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": f"{KEY} {BODY_MARKER}", "Key": KEY},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        "GetObject",
    )


# Hatanın zincirsiz olduğunu, metninde anahtar adı, gövde ya da kimlik olmadığını sınar.
def assert_clean_error(error: BaseException) -> None:
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error))
    for text in FORBIDDEN_TEXTS:
        assert text not in rendered
        assert text not in repr(error)


# Storage loglarında yasaklı metin ve istisna olmadığını sınar, kayıtları döndürür.
def clean_storage_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    records = [r for r in caplog.records if r.name == STORAGE_LOGGER]
    for record in records:
        assert record.exc_info is None
        rendered = " ".join([record.getMessage(), *map(str, vars(record).values())])
        for text in FORBIDDEN_TEXTS:
            assert text not in rendered
        assert isinstance(getattr(record, "durationMs", None), int)
    return records


# Kalıcı hatanın kodunu, zincirsizliğini ve logdaki hata kodunu birlikte doğrular.
def assert_permanent(
    error: PermanentError, code: str, caplog: pytest.LogCaptureFixture
) -> None:
    assert error.code == code
    assert str(error) == code
    assert_clean_error(error)
    [record] = clean_storage_records(caplog)
    assert record.levelno == logging.WARNING
    assert getattr(record, "errorCode", None) == code


# Doğru boyut ve sha256'da gövdenin döndüğünü, sha256'nın harf duyarsız olduğunu sınar.
@pytest.mark.parametrize(
    "expected_sha256",
    [
        pytest.param(BODY_SHA256, id="kucuk-harf"),
        pytest.param(BODY_SHA256.upper(), id="buyuk-harf"),
    ],
)
async def test_read_returns_body_when_size_and_sha256_match(
    stubbed: tuple[DocumentStorage, Stubber],
    caplog: pytest.LogCaptureFixture,
    expected_sha256: str,
) -> None:
    storage, stubber = stubbed
    body = FakeBody()
    add_object(stubber, body, len(BODY))

    data = await storage.read(KEY, len(BODY), expected_sha256)

    assert data == BODY
    assert body.read_calls == 1
    assert body.closed is True
    [record] = clean_storage_records(caplog)
    assert record.levelno == logging.INFO
    assert not hasattr(record, "errorCode")


# Boyut farkında gövdenin okunmadan kapandığını ve FILE_INTEGRITY_ERROR verdiğini sınar.
@pytest.mark.parametrize(
    "content_length",
    [
        pytest.param(len(BODY) - 1, id="kucuk"),
        pytest.param(len(BODY) + 1, id="buyuk"),
        pytest.param(0, id="bos"),
        pytest.param(None, id="boyut-yok"),
    ],
)
async def test_size_mismatch_closes_body_without_reading(
    stubbed: tuple[DocumentStorage, Stubber],
    caplog: pytest.LogCaptureFixture,
    content_length: int | None,
) -> None:
    storage, stubber = stubbed
    body = FakeBody()
    add_object(stubber, body, content_length)

    with pytest.raises(PermanentError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert body.read_calls == 0
    assert body.closed is True
    assert_permanent(raised.value, FILE_INTEGRITY_ERROR, caplog)


# sha256 farkında gövde kapatılarak FILE_INTEGRITY_ERROR verildiğini doğrular.
async def test_sha256_mismatch_is_integrity_error(
    stubbed: tuple[DocumentStorage, Stubber], caplog: pytest.LogCaptureFixture
) -> None:
    storage, stubber = stubbed
    body = FakeBody()
    add_object(stubber, body, len(BODY))

    with pytest.raises(PermanentError) as raised:
        await storage.read(KEY, len(BODY), OTHER_SHA256)

    assert body.read_calls == 1
    assert body.closed is True
    assert_permanent(raised.value, FILE_INTEGRITY_ERROR, caplog)


# NoSuchKey yanıtının FILE_NOT_FOUND'a çevrildiğini doğrular.
async def test_missing_object_is_file_not_found(
    stubbed: tuple[DocumentStorage, Stubber], caplog: pytest.LogCaptureFixture
) -> None:
    storage, stubber = stubbed
    add_error(stubber, "NoSuchKey", 404)

    with pytest.raises(PermanentError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert raised.value.__suppress_context__ is True
    assert_permanent(raised.value, FILE_NOT_FOUND, caplog)


# Kodu NoSuchKey olmayan 404 yanıtlarının ClientError olarak yükseldiğini doğrular.
@pytest.mark.parametrize(
    "code",
    [
        pytest.param("NoSuchBucket", id="no-such-bucket"),
        pytest.param("404", id="kodsuz-404"),
    ],
)
async def test_other_not_found_responses_raise_client_error(
    stubbed: tuple[DocumentStorage, Stubber],
    caplog: pytest.LogCaptureFixture,
    code: str,
) -> None:
    storage, stubber = stubbed
    add_error(stubber, code, 404)

    with pytest.raises(ClientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert raised.value.response["Error"]["Code"] == code
    assert raised.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404
    [record] = clean_storage_records(caplog)
    assert not hasattr(record, "errorCode")
    assert "404" in record.getMessage()


# Hata kodu taşımayan 404'ün aynı ClientError nesnesiyle yükseldiğini doğrular.
async def test_codeless_not_found_propagates_unchanged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    error = ClientError({"ResponseMetadata": {"HTTPStatusCode": 404}}, "GetObject")
    storage = fake_storage(FakeClient(error))

    with pytest.raises(ClientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert raised.value is error
    [record] = clean_storage_records(caplog)
    assert "404" in record.getMessage()


CONNECTION_ERRORS = [
    pytest.param(
        lambda: EndpointConnectionError(endpoint_url=ENDPOINT_WITH_KEY),
        id="baglanti-kurulamadi",
    ),
    pytest.param(
        lambda: ConnectTimeoutError(endpoint_url=ENDPOINT_WITH_KEY),
        id="baglanti-zaman-asimi",
    ),
    pytest.param(
        lambda: ReadTimeoutError(endpoint_url=ENDPOINT_WITH_KEY),
        id="okuma-zaman-asimi",
    ),
    pytest.param(
        lambda: ConnectionClosedError(endpoint_url=ENDPOINT_WITH_KEY),
        id="baglanti-kapandi",
    ),
]

STREAM_ERRORS = [
    pytest.param(
        lambda: ReadTimeoutError(endpoint_url=ENDPOINT_WITH_KEY),
        id="okuma-zaman-asimi",
    ),
    pytest.param(
        lambda: ResponseStreamingError(error=f"{KEY} {BODY_MARKER}"),
        id="akis-koptu",
    ),
    pytest.param(
        lambda: IncompleteReadError(actual_bytes=1, expected_bytes=len(BODY)),
        id="eksik-okuma",
    ),
]


# Bağlantı ve zaman aşımı hatalarının zincirsiz TransientError'a çevrildiğini doğrular.
@pytest.mark.parametrize("make_error", CONNECTION_ERRORS)
async def test_connection_errors_are_transient(
    caplog: pytest.LogCaptureFixture, make_error: Callable[[], Exception]
) -> None:
    error = make_error()
    storage = fake_storage(FakeClient(error))

    with pytest.raises(TransientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert type(error).__name__ in str(raised.value)
    assert raised.value.__suppress_context__ is True
    assert_clean_error(raised.value)
    [record] = clean_storage_records(caplog)
    assert record.levelno == logging.WARNING


# Gövde okunurken kopan akışın gövde kapatılarak TransientError'a çevrildiğini doğrular.
@pytest.mark.parametrize("make_error", STREAM_ERRORS)
async def test_body_stream_errors_are_transient(
    stubbed: tuple[DocumentStorage, Stubber],
    caplog: pytest.LogCaptureFixture,
    make_error: Callable[[], Exception],
) -> None:
    storage, stubber = stubbed
    body = FakeBody(error=make_error())
    add_object(stubber, body, len(BODY))

    with pytest.raises(TransientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert body.closed is True
    assert raised.value.__suppress_context__ is True
    assert_clean_error(raised.value)
    clean_storage_records(caplog)


# Deponun 500 ve 503 yanıtlarının zincirsiz TransientError'a çevrildiğini doğrular.
@pytest.mark.parametrize(
    ("code", "status"),
    [
        pytest.param("InternalError", 500, id="http-500"),
        pytest.param("ServiceUnavailable", 503, id="http-503"),
        pytest.param("SlowDown", 503, id="http-503-slowdown"),
    ],
)
async def test_server_errors_are_transient(
    stubbed: tuple[DocumentStorage, Stubber],
    caplog: pytest.LogCaptureFixture,
    code: str,
    status: int,
) -> None:
    storage, stubber = stubbed
    add_error(stubber, code, status)

    with pytest.raises(TransientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert str(status) in str(raised.value)
    assert raised.value.__suppress_context__ is True
    assert_clean_error(raised.value)
    clean_storage_records(caplog)


# 403 gibi diğer depo hatalarının aynı ClientError nesnesiyle yükseldiğini doğrular.
@pytest.mark.parametrize(
    ("code", "status"),
    [
        pytest.param("AccessDenied", 403, id="http-403"),
        pytest.param("InvalidRequest", 400, id="http-400"),
    ],
)
async def test_other_client_errors_propagate_unchanged(
    caplog: pytest.LogCaptureFixture, code: str, status: int
) -> None:
    error = client_error(code, status)
    storage = fake_storage(FakeClient(error))

    with pytest.raises(ClientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert raised.value is error
    [record] = clean_storage_records(caplog)
    assert str(status) in record.getMessage()


# Stubber'lı gerçek istemcide 403 yanıtının ClientError olarak yükseldiğini doğrular.
async def test_forbidden_response_raises_client_error(
    stubbed: tuple[DocumentStorage, Stubber], caplog: pytest.LogCaptureFixture
) -> None:
    storage, stubber = stubbed
    add_error(stubber, "AccessDenied", 403)

    with pytest.raises(ClientError) as raised:
        await storage.read(KEY, len(BODY), BODY_SHA256)

    assert raised.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
    clean_storage_records(caplog)


# get_object'in doğru kova ve anahtarla, ayrı bir iş parçacığında çağrıldığını sınar.
async def test_read_calls_client_in_worker_thread() -> None:
    client = FakeClient()

    data = await fake_storage(client).read(KEY, len(BODY), BODY_SHA256)

    assert data == BODY
    assert client.calls == [EXPECTED_PARAMS]
    [thread_id] = client.thread_ids
    assert thread_id != threading.get_ident()


# Session'ı, kurulan istemcileri ve parametrelerini kaydeden bir alt sınıfla değiştirir.
@pytest.fixture
def recorded_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[BaseClient, dict[str, Any]]]:
    created: list[tuple[BaseClient, dict[str, Any]]] = []

    class RecordingSession(Session):
        # Gerçek istemciyi kurar ve parametreleriyle birlikte kaydeder.
        def client(self, *args: Any, **kwargs: Any) -> Any:
            client = super().client(*args, **kwargs)
            created.append((client, {"args": args, **kwargs}))
            return client

    monkeypatch.setattr(storage_module, "Session", RecordingSession)
    return created


# create_storage'ın uç nokta, bölge, path adresleme ve checksum ayarlarını sınar.
def test_create_storage_configures_client(
    recorded_clients: list[tuple[BaseClient, dict[str, Any]]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="botocore")
    caplog.set_level(logging.DEBUG, logger="boto3")

    storage = create_storage(fake_settings())

    assert isinstance(storage, DocumentStorage)
    [(client, params)] = recorded_clients
    assert params["args"] == ("s3",)
    assert params["aws_access_key_id"] == FAKE_ACCESS_KEY
    assert params["aws_secret_access_key"] == FAKE_SECRET_KEY
    assert client.meta.endpoint_url == ENDPOINT
    assert client.meta.region_name == "us-east-1"
    config = client.meta.config
    assert config.s3 == {"addressing_style": "path"}
    assert config.request_checksum_calculation == "when_required"
    assert config.response_checksum_validation == "when_required"
    default = make_client().meta.config
    assert config.connect_timeout == default.connect_timeout
    assert config.read_timeout == default.read_timeout
    assert config.retries == default.retries
    for text in (FAKE_ACCESS_KEY, FAKE_SECRET_KEY):
        assert text not in caplog.text
        for record in caplog.records:
            assert text not in " ".join(map(str, vars(record).values()))


# Tek istemcinin path tarzı URL'ye imzalı ve checksum başlıksız istek attığını sınar.
async def test_create_storage_client_sends_path_style_requests(
    recorded_clients: list[tuple[BaseClient, dict[str, Any]]],
) -> None:
    storage = create_storage(fake_settings())
    [(client, _)] = recorded_clients
    requests: list[AWSPreparedRequest] = []

    # İsteği kaydeder ve ağa çıkmadan doğru boyutta sahte bir 200 yanıtı döndürür.
    def answer(request: AWSPreparedRequest, **_: Any) -> AWSResponse:
        requests.append(request)
        headers = {"Content-Length": str(len(BODY))}
        return AWSResponse(request.url, 200, headers, FakeBody())

    client.meta.events.register("before-send.s3.GetObject", answer)

    assert await storage.read(KEY, len(BODY), BODY_SHA256) == BODY
    assert await storage.read(KEY, len(BODY), BODY_SHA256.upper()) == BODY

    assert len(recorded_clients) == 1
    assert len(requests) == 2
    for request in requests:
        assert request.url == f"{ENDPOINT}/{BUCKET}/{KEY}"
        headers = {name.lower(): value for name, value in request.headers.items()}
        authorization = headers["authorization"]
        if isinstance(authorization, bytes):
            authorization = authorization.decode()
        assert authorization.startswith(
            f"AWS4-HMAC-SHA256 Credential={FAKE_ACCESS_KEY}/"
        )
        assert "/us-east-1/s3/aws4_request" in authorization
        assert not any(name.startswith("x-amz-checksum") for name in headers)
        assert "x-amz-sdk-checksum-algorithm" not in headers
        rendered = " ".join(str(value) for value in headers.values())
        assert FAKE_SECRET_KEY not in rendered
