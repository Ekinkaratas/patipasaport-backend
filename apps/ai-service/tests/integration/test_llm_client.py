import base64
import io
import logging
from datetime import UTC, date, datetime, timedelta

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.config import Settings
from app.documents.validate import (
    BUSINESS_TIME_ZONE,
    ExtractionInvalid,
    ExtractionResult,
    ValidationIssue,
    validate_extraction,
)
from app.errors import PermanentError, TransientError
from app.generated import medical_record_pb2
from app.llm.client import (
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    UnexpectedStatusError,
    create_llm_client,
)
from app.llm.prompts import (
    EXTRACT_SYSTEM_PROMPT,
    EXTRACT_TASK_TEXT,
    build_correction_text,
)
from app.llm.schemas import EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME

pytestmark = pytest.mark.integration

LLM_LOGGER = "LlmClient"
QUIET_LOGGERS = ("httpx", "httpcore")
MAX_MODEL_REQUESTS = 2
SAMPLE_AGE_DAYS = 3
EXPECTED_ITEM_COUNT = 3
IMAGE_SIZE = (1100, 560)
FONT_SIZE = 30
TITLE_FONT_SIZE = 42
LEFT_MARGIN = 60
RIGHT_MARGIN = 1040
COLUMN_X = (LEFT_MARGIN, 300, 540, 780)
HEADER_Y = 200
FIRST_ROW_Y = 270
ROW_HEIGHT = 70
JPEG_QUALITY = 90
TABLE_HEADER = ("Test", "Sonuc", "Birim", "Referans")
LAB_ROWS = (
    ("WBC", "12.5", "10^3/uL", "6.0-17.0"),
    ("RBC", "6.8", "10^6/uL", "5.5-8.5"),
    ("HGB", "15.2", "g/dL", "12.0-18.0"),
)
CLIENT_FAILURES = (PermanentError, TransientError, UnexpectedStatusError)


# Tarihli, üç kalemli ve kişisel veri içermeyen sentetik bir hemogramı data URL yapar.
def synthetic_hemogram(sample_day: date) -> str:
    image = Image.new("RGB", IMAGE_SIZE, "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=FONT_SIZE)
    title_font = ImageFont.load_default(size=TITLE_FONT_SIZE)
    draw.text((LEFT_MARGIN, 40), "HEMOGRAM", fill="black", font=title_font)
    draw.text(
        (LEFT_MARGIN, 110), f"Tarih: {sample_day:%d.%m.%Y}", fill="black", font=font
    )
    for x, text in zip(COLUMN_X, TABLE_HEADER, strict=True):
        draw.text((x, HEADER_Y), text, fill="black", font=font)
    line_y = HEADER_Y + 45
    draw.line((LEFT_MARGIN, line_y, RIGHT_MARGIN, line_y), fill="black", width=2)
    for index, row in enumerate(LAB_ROWS):
        row_y = FIRST_ROW_Y + index * ROW_HEIGHT
        for x, text in zip(COLUMN_X, row, strict=True):
            draw.text((x, row_y), text, fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


# Doğrulama sorunlarını değer içermeden alan yolu ve kural koduyla listeler.
def issue_codes(issues: tuple[ValidationIssue, ...]) -> str:
    return ", ".join(f"{issue.path} {issue.code}" for issue in issues)


# En fazla iki model isteğiyle görseli çıkarır; sonucu ya da kodlu sorun metnini verir.
async def extract(
    client: LlmClient, image_url: str
) -> tuple[ExtractionResult | None, str]:
    follow_up: tuple[ChatTurn, ...] = ()
    problem = "Model isteği yapılmadı"
    for _ in range(MAX_MODEL_REQUESTS):
        try:
            reply = await client.complete_json(
                system_prompt=EXTRACT_SYSTEM_PROMPT,
                user_text=EXTRACT_TASK_TEXT,
                image_data_urls=(image_url,),
                schema_name=EXTRACTION_SCHEMA_NAME,
                schema=EXTRACTION_SCHEMA,
                follow_up=follow_up,
            )
        except IncompleteOutputError:
            problem = "Model yanıtı yarım ya da boş geldi"
            follow_up = ()
            continue
        except CLIENT_FAILURES as error:
            return (
                None,
                f"Model isteği başarısız oldu ({type(error).__name__}: {error})",
            )
        try:
            return validate_extraction(reply.content, event_time=datetime.now(UTC)), ""
        except ExtractionInvalid as error:
            issues = error.issues
        except PermanentError as error:
            return None, f"Model çıktısı reddedildi ({error.code})"
        problem = f"Model çıktısı doğrulanamadı ({issue_codes(issues)})"
        follow_up = (
            ChatTurn("assistant", reply.content),
            ChatTurn("user", build_correction_text(issues)),
        )
    return None, problem


# Son LlmClient kaydındaki HTTP durum kodunu ek metin olarak döndürür, yoksa boş verir.
def last_status(caplog: pytest.LogCaptureFixture) -> str:
    statuses = [
        getattr(record, "statusCode", None)
        for record in caplog.records
        if record.name == LLM_LOGGER and hasattr(record, "statusCode")
    ]
    return f" [son durum kodu: HTTP {statuses[-1]}]" if statuses else ""


# Gerçek API'nin çıkarım şemasını talimatla kabul edip 3 kalemli tahlil verdiğini sınar.
async def test_extraction_schema_and_prompt_work_with_provider(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    caplog.set_level(logging.INFO, logger=LLM_LOGGER)
    sample_day = datetime.now(BUSINESS_TIME_ZONE).date() - timedelta(
        days=SAMPLE_AGE_DAYS
    )
    client = create_llm_client(settings)
    try:
        result, problem = await extract(client, synthetic_hemogram(sample_day))
    finally:
        await client.aclose()
    if result is None:
        pytest.fail(f"{problem}{last_status(caplog)}", pytrace=False)
    proposal = result.proposal
    record_type = medical_record_pb2.RecordType.Name(proposal.type)
    details = proposal.WhichOneof("details")
    item_count = len(proposal.lab_result.items)
    if (
        record_type != "LAB_RESULT"
        or details != "lab_result"
        or item_count != EXPECTED_ITEM_COUNT
    ):
        pytest.fail(
            f"Beklenmeyen öneri: tür {record_type}, ayrıntı {details}, "
            f"kalem sayısı {item_count}",
            pytrace=False,
        )
    assert isinstance(proposal, medical_record_pb2.RecordContent)
