import asyncio
import hashlib
import time

from boto3.session import Session
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import ClientError, HTTPClientError, IncompleteReadError
from botocore.exceptions import ConnectionError as BotoConnectionError

from app.config import Settings
from app.errors import (
    FILE_INTEGRITY_ERROR,
    FILE_NOT_FOUND,
    PermanentError,
    TransientError,
)
from app.logs import get_logger

S3_REGION = "us-east-1"
NOT_FOUND_ERROR_CODE = "NoSuchKey"

_TRANSIENT_ERRORS = (BotoConnectionError, HTTPClientError, IncompleteReadError)
_log = get_logger("Storage")


# Başlangıçtan bu yana geçen süreyi milisaniye olarak döndürür.
def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


# Depo yanıtının HTTP durum kodunu döndürür, yoksa None verir.
def _status_code(error: ClientError) -> int | None:
    status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return status if isinstance(status, int) else None


# Yalnızca NoSuchKey'i FILE_NOT_FOUND'a, 5xx'i geçici hataya çevirir, yoksa None verir.
def _classify_client_error(error: ClientError) -> Exception | None:
    if error.response.get("Error", {}).get("Code") == NOT_FOUND_ERROR_CODE:
        return PermanentError(FILE_NOT_FOUND)
    status = _status_code(error)
    if status is not None and 500 <= status <= 599:
        return TransientError(f"Dosya deposu HTTP {status} yanıtı verdi")
    return None


class DocumentStorage:
    # Salt okunur S3 istemcisini ve kova adını tüm okumalarda kullanmak üzere saklar.
    def __init__(self, client: BaseClient, bucket: str) -> None:
        self._client = client
        self._bucket = bucket

    # Belgeyi depodan okur, boyut ve sha256'yı doğrular ve sonucu loglar.
    async def read(
        self, storage_path: str, expected_size: int, expected_sha256: str
    ) -> bytes:
        started = time.monotonic()
        try:
            data = await asyncio.to_thread(
                self._read_sync, storage_path, expected_size, expected_sha256
            )
        except PermanentError as error:
            _log.warning(
                "Belge dosyası okunamadı",
                extra={"errorCode": error.code, "durationMs": _elapsed_ms(started)},
            )
            raise
        except TransientError as error:
            _log.warning(
                "Dosya deposunda geçici hata: %s",
                error,
                extra={"durationMs": _elapsed_ms(started)},
            )
            raise
        except ClientError as error:
            _log.warning(
                "Dosya deposu beklenmeyen bir hata yanıtı verdi (HTTP %s)",
                _status_code(error),
                extra={"durationMs": _elapsed_ms(started)},
            )
            raise
        _log.info(
            "Belge dosyası depodan okundu", extra={"durationMs": _elapsed_ms(started)}
        )
        return data

    # Okumayı yapar; depo hatalarını zincirsiz uygulama hatalarına çevirir.
    def _read_sync(
        self, storage_path: str, expected_size: int, expected_sha256: str
    ) -> bytes:
        try:
            return self._fetch(storage_path, expected_size, expected_sha256)
        except ClientError as error:
            failure = _classify_client_error(error)
            if failure is None:
                raise
        except _TRANSIENT_ERRORS as error:
            failure = TransientError(
                f"Dosya deposuna ulaşılamadı ({type(error).__name__})"
            )
        raise failure from None

    # Nesneyi ister; boyut uyuşmazsa gövdeyi okumadan kapatır, sonra sha256'yı denetler.
    def _fetch(
        self, storage_path: str, expected_size: int, expected_sha256: str
    ) -> bytes:
        response = self._client.get_object(Bucket=self._bucket, Key=storage_path)
        body = response["Body"]
        try:
            if response.get("ContentLength") != expected_size:
                raise PermanentError(FILE_INTEGRITY_ERROR)
            data = body.read()
        finally:
            body.close()
        if hashlib.sha256(data).hexdigest() != expected_sha256.lower():
            raise PermanentError(FILE_INTEGRITY_ERROR)
        return data


# Ayarlardaki uç nokta ve salt okunur anahtarlarla tek bir S3 istemcisi kurar.
def create_storage(settings: Settings) -> DocumentStorage:
    client = Session().client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=S3_REGION,
        aws_access_key_id=settings.s3_access_key.get_secret_value(),
        aws_secret_access_key=settings.s3_secret_key.get_secret_value(),
        config=Config(
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )
    return DocumentStorage(client, settings.s3_bucket)
