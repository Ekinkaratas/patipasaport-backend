import time
from datetime import UTC, datetime


# Şimdiki zamanı UTC olarak döndürür.
def utc_now() -> datetime:
    return datetime.now(UTC)


# Zamanı UTC'de, milisaniyeli ve Z ile biten ISO-8601 metnine çevirir.
def format_time(moment: datetime) -> str:
    utc = moment.replace(tzinfo=UTC) if moment.utcoffset() is None else moment
    text = utc.astimezone(UTC).isoformat(timespec="milliseconds")
    return text.replace("+00:00", "Z")


# Başlangıçtan bu yana geçen süreyi milisaniye olarak döndürür.
def elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)
