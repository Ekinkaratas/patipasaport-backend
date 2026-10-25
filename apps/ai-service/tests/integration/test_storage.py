import secrets

import pytest
from botocore.exceptions import ClientError

from app.config import Settings
from app.errors import FILE_NOT_FOUND, PermanentError, TransientError
from app.storage import create_storage

pytestmark = pytest.mark.integration

MISSING_SIZE = 1
MISSING_SHA256 = "0" * 64
UNREACHABLE_MESSAGE = (
    "SeaweedFS'e ulaşılamadı ya da geçici hata verdi: {}. Ana proje dev modunda "
    "çalışıyor olmalı ve S3_ENDPOINT ayarı yerel geliştirmeye uygun olmalı."
)


# Kesinlikle var olmayan, rastgele adlı bir nesne anahtarı üretir.
def missing_key() -> str:
    return f"ai-service-it-{secrets.token_hex(16)}.pdf"


# Gerçek ayarlı salt okunur istemcinin olmayan anahtarda FILE_NOT_FOUND verdiğini sınar.
async def test_missing_key_reports_file_not_found(settings: Settings) -> None:
    storage = create_storage(settings)
    failure: str | None = None
    code: str | None = None
    try:
        await storage.read(missing_key(), MISSING_SIZE, MISSING_SHA256)
    except PermanentError as error:
        code = error.code
    except TransientError as error:
        failure = UNREACHABLE_MESSAGE.format(str(error))
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        failure = f"SeaweedFS isteği reddetti (HTTP {status})"
    else:
        failure = "Var olmayan anahtar için gövde döndü"
    if failure is not None:
        pytest.fail(failure, pytrace=False)
    assert code == FILE_NOT_FOUND
