from collections.abc import Mapping
from types import MappingProxyType

FILE_NOT_FOUND = "FILE_NOT_FOUND"
FILE_INTEGRITY_ERROR = "FILE_INTEGRITY_ERROR"
UNSUPPORTED_MIME_TYPE = "UNSUPPORTED_MIME_TYPE"
UNREADABLE_DOCUMENT = "UNREADABLE_DOCUMENT"
TOO_MANY_PAGES = "TOO_MANY_PAGES"
NOT_A_MEDICAL_DOCUMENT = "NOT_A_MEDICAL_DOCUMENT"
INVALID_AI_OUTPUT = "INVALID_AI_OUTPUT"
AI_PROVIDER_REJECTED = "AI_PROVIDER_REJECTED"
AI_PROVIDER_UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE"
INTERNAL_ERROR = "INTERNAL_ERROR"

ERROR_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        FILE_NOT_FOUND: "Belge dosyası depoda bulunamadı",
        FILE_INTEGRITY_ERROR: (
            "Belge dosyasının boyutu ya da sha256 özeti kayıtla uyuşmuyor"
        ),
        UNSUPPORTED_MIME_TYPE: "Belge dosyasının türü desteklenmiyor",
        UNREADABLE_DOCUMENT: "PDF ya da görsel dosyası açılamadı",
        TOO_MANY_PAGES: "PDF belgesi 8 sayfadan uzun",
        NOT_A_MEDICAL_DOCUMENT: "Belgede kayıt çıkarılacak tıbbi bilgi bulunamadı",
        INVALID_AI_OUTPUT: "Model iki denemede de kurallara uygun JSON vermedi",
        AI_PROVIDER_REJECTED: "AI API isteği reddetti",
        AI_PROVIDER_UNAVAILABLE: (
            "AI API'ye ya da dosya deposuna 5 denemede de ulaşılamadı"
        ),
        INTERNAL_ERROR: "AI servisindeki beklenmeyen bir hata 5 denemede de sürdü",
    }
)


class TransientError(Exception):
    pass


class PermanentError(Exception):
    # Hatayı ERROR_MESSAGES'ta tanımlı bir kodla oluşturur, bilinmeyen kodu reddeder.
    def __init__(self, code: str) -> None:
        if not isinstance(code, str) or code not in ERROR_MESSAGES:
            raise ValueError("Bilinmeyen hata kodu")
        super().__init__(code)
        self.code = code

    # Hatanın metin karşılığı olarak yalnızca hata kodunu döndürür.
    def __str__(self) -> str:
        return self.code
