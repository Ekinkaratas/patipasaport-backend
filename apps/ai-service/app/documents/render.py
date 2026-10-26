import asyncio
import base64
import io
import math
import threading
import warnings
from collections.abc import Callable

import pypdfium2 as pdfium
from PIL import Image, ImageFile, ImageOps

from app.errors import (
    TOO_MANY_PAGES,
    UNREADABLE_DOCUMENT,
    UNSUPPORTED_MIME_TYPE,
    PermanentError,
)

SUPPORTED_MIME_TYPES = ("application/pdf", "image/jpeg", "image/png")
MAX_PDF_PAGES = 8
PDF_RENDER_SCALE = 2
MAX_LONG_SIDE = 2048
JPEG_QUALITY = 85

_PDF_MIME_TYPE = "application/pdf"
_IMAGE_FORMATS: dict[str, tuple[str, ...]] = {
    "image/jpeg": ("JPEG",),
    "image/png": ("PNG",),
}
_DATA_URL_PREFIX = "data:image/jpeg;base64,"
_WHITE = (255, 255, 255)
_PASSTHROUGH_ERRORS = (
    PermanentError,
    MemoryError,
    TypeError,
    AttributeError,
    NameError,
    AssertionError,
    ImportError,
)

_PDFIUM_LOCK = threading.Lock()
_IMAGE_OPEN_LOCK = threading.Lock()


# Belgeyi sayfa sırasıyla JPEG base64 data URL listesine çevirir (sözleşme 6.4).
async def prepare_images(content: bytes, mime_type: str) -> list[str]:
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise PermanentError(UNSUPPORTED_MIME_TYPE)
    if mime_type == _PDF_MIME_TYPE:
        return await asyncio.to_thread(_run_guarded, _prepare_pdf, content)
    return await asyncio.to_thread(
        _run_guarded, _prepare_image, content, _IMAGE_FORMATS[mime_type]
    )


# İşi çalıştırır; beklenmeyen kütüphane hatalarını UNREADABLE_DOCUMENT'e çevirir.
def _run_guarded[**P, R](func: Callable[P, R], *args: P.args, **kwargs: P.kwargs) -> R:
    try:
        return func(*args, **kwargs)
    except _PASSTHROUGH_ERRORS:
        raise
    except Exception:
        raise PermanentError(UNREADABLE_DOCUMENT) from None


# PDF sayfalarını render edip her birini normalleştirilmiş JPEG data URL'ine çevirir.
def _prepare_pdf(content: bytes) -> list[str]:
    pages = _render_pdf_pages(content)
    return [_to_data_url(_normalize(page)) for page in pages]


# PDF'i kilit altında açıp formları kurar, sayfa sınırını denetler ve sayfaları çizer.
def _render_pdf_pages(content: bytes) -> list[Image.Image]:
    with _PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(content)
        try:
            pdf.init_forms()
            page_count = len(pdf)
            if page_count < 1:
                raise PermanentError(UNREADABLE_DOCUMENT)
            if page_count > MAX_PDF_PAGES:
                raise PermanentError(TOO_MANY_PAGES)
            return [_render_page(pdf, index) for index in range(page_count)]
        finally:
            pdf.close()


# Sayfayı form alanlarıyla, uzun kenar sınırına uyan ölçekte çizer; kilit çağıranda.
def _render_page(pdf: pdfium.PdfDocument, index: int) -> Image.Image:
    page = pdf[index]
    try:
        width, height = page.get_size()
        if not all(0 < side < math.inf for side in (width, height)):
            raise PermanentError(UNREADABLE_DOCUMENT)
        scale = min(PDF_RENDER_SCALE, MAX_LONG_SIDE / max(width, height))
        bitmap = page.render(scale=scale, may_draw_forms=True)
        try:
            return bitmap.to_pil().convert("RGB")
        finally:
            bitmap.close()
    finally:
        page.close()


# JPEG ya da PNG görseli açar, yönünü EXIF'e göre düzeltir ve JPEG data URL'ine çevirir.
def _prepare_image(content: bytes, formats: tuple[str, ...]) -> list[str]:
    with _open_image(content, formats) as image:
        target = _fit_size(image.size)
        if target != image.size:
            image.draft(None, target)
        ImageOps.exif_transpose(image, in_place=True)
        return [_to_data_url(_normalize(image))]


# Görseli yalnızca beklenen biçimde açar ve piksel sınırı uyarısını da hata sayar.
def _open_image(content: bytes, formats: tuple[str, ...]) -> ImageFile.ImageFile:
    with _IMAGE_OPEN_LOCK, warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        return Image.open(io.BytesIO(content), formats=formats)


# Görseli beyaz zeminli RGB'ye çevirir ve uzun kenarı sınırı aşıyorsa küçültür.
def _normalize(image: Image.Image) -> Image.Image:
    if image.has_transparency_data:
        rgba = _shrink(image.convert("RGBA"))
        background = Image.new("RGB", rgba.size, _WHITE)
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return _shrink(image if image.mode == "RGB" else image.convert("RGB"))


# Uzun kenarı sınırı aşan görseli oranı koruyarak küçültür; küçük görseli büyütmez.
def _shrink(image: Image.Image) -> Image.Image:
    target = _fit_size(image.size)
    if target == image.size:
        return image
    return image.resize(target, Image.Resampling.LANCZOS)


# Uzun kenarı MAX_LONG_SIDE'ı aşmayan ve en-boy oranını koruyan boyutu hesaplar.
def _fit_size(size: tuple[int, int]) -> tuple[int, int]:
    width, height = size
    long_side = max(width, height)
    if long_side <= MAX_LONG_SIDE:
        return size
    ratio = MAX_LONG_SIDE / long_side
    return max(1, round(width * ratio)), max(1, round(height * ratio))


# Görseli girdideki meta verileri taşımadan JPEG olarak kodlayıp data URL'e çevirir.
def _to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY, comment=b"")
    return _DATA_URL_PREFIX + base64.b64encode(buffer.getvalue()).decode("ascii")
