import asyncio
import base64
import io
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pypdfium2 as pdfium
import pytest
from PIL import ExifTags, Image, ImageOps

from app.documents.render import (
    JPEG_QUALITY,
    MAX_LONG_SIDE,
    MAX_PDF_PAGES,
    PDF_RENDER_SCALE,
    SUPPORTED_MIME_TYPES,
    prepare_images,
)
from app.errors import (
    TOO_MANY_PAGES,
    UNREADABLE_DOCUMENT,
    UNSUPPORTED_MIME_TYPE,
    PermanentError,
)

PDF = "application/pdf"
JPEG = "image/jpeg"
PNG = "image/png"
DATA_URL_PREFIX = "data:image/jpeg;base64,"
COLOR_TOLERANCE = 16
RED = (220, 20, 20)
BLUE = (20, 20, 220)
WHITE = (255, 255, 255)
PAGE_COLORS = (
    (220, 20, 20),
    (20, 160, 20),
    (20, 20, 220),
    (230, 200, 20),
    (200, 20, 200),
    (20, 200, 200),
    (120, 60, 0),
    (0, 0, 0),
    (255, 255, 255),
    (128, 128, 128),
)
ZERO_PAGE_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"
    b"trailer\n<< /Root 1 0 R >>\n%%EOF\n"
)
FORM_PAGE_SIZE = (400, 200)
FORM_FIELD_BOX = (20, 60, 380, 140)


@dataclass
class PdfiumSpy:
    documents: list[Any] = field(default_factory=list)
    pages: list[Any] = field(default_factory=list)
    bitmaps: list[Any] = field(default_factory=list)
    formenvs: list[Any] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    scales: list[float] = field(default_factory=list)
    active: int = 0
    max_active: int = 0
    guard: threading.Lock = field(default_factory=threading.Lock)


# Belge, form, sayfa ve render çağrılarını kaydeden pypdfium2 casusunu kurar.
@pytest.fixture
def pdfium_spy(monkeypatch: pytest.MonkeyPatch) -> PdfiumSpy:
    spy = PdfiumSpy()
    original_init = pdfium.PdfDocument.__init__
    original_init_forms = pdfium.PdfDocument.init_forms
    original_len = pdfium.PdfDocument.__len__
    original_get_page = pdfium.PdfDocument.get_page
    original_render = pdfium.PdfPage.render

    # Belgeyi açıp kaydeder.
    def recording_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        spy.documents.append(self)

    # Form ortamını kurar; çağrıyı ve oluşan ortamı kaydeder.
    def recording_init_forms(self: Any, *args: Any, **kwargs: Any) -> bool:
        spy.events.append("init_forms")
        result = original_init_forms(self, *args, **kwargs)
        if self.formenv:
            spy.formenvs.append(self.formenv)
        return result

    # Sayfa sayısını okur ve çağrıyı kaydeder.
    def recording_len(self: Any) -> int:
        spy.events.append("len")
        return original_len(self)

    # Sayfayı yükleyip kaydeder.
    def recording_get_page(self: Any, index: int) -> Any:
        spy.events.append("get_page")
        page = original_get_page(self, index)
        spy.pages.append(page)
        return page

    # Render ölçeğini, bitmap'i ve aynı anda süren render sayısını kaydeder.
    def recording_render(self: Any, *args: Any, **kwargs: Any) -> Any:
        with spy.guard:
            spy.active += 1
            spy.max_active = max(spy.max_active, spy.active)
        try:
            time.sleep(0.02)
            bitmap = original_render(self, *args, **kwargs)
        finally:
            with spy.guard:
                spy.active -= 1
        spy.scales.append(kwargs.get("scale", args[0] if args else 1))
        spy.bitmaps.append(bitmap)
        return bitmap

    monkeypatch.setattr(pdfium.PdfDocument, "__init__", recording_init)
    monkeypatch.setattr(pdfium.PdfDocument, "init_forms", recording_init_forms)
    monkeypatch.setattr(pdfium.PdfDocument, "__len__", recording_len)
    monkeypatch.setattr(pdfium.PdfDocument, "get_page", recording_get_page)
    monkeypatch.setattr(pdfium.PdfPage, "render", recording_render)
    return spy


# Görseli verilen biçimde belleğe kaydedip baytlarını döndürür.
def _encode(image: Image.Image, image_format: str, **params: Any) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, image_format, **params)
    return buffer.getvalue()


# Her sayfası verilen düz renkte olan çok sayfalı bir PDF üretir.
def _pdf(
    colors: list[tuple[int, int, int]] | tuple[tuple[int, int, int], ...],
    size: tuple[int, int] = (60, 80),
    resolution: float = 72.0,
) -> bytes:
    pages = [Image.new("RGB", size, color) for color in colors]
    return _encode(
        pages[0], "PDF", save_all=True, append_images=pages[1:], resolution=resolution
    )


# Doldurulmuş tek bir metin alanı içeren, görünüm akışı olmayan 200x100 pt PDF üretir.
def _form_pdf() -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] "
        b"/DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Annots [4 0 R] >>",
        b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (alan) /V (ORNEK 123) "
        b"/Rect [10 30 190 70] /F 4 /P 3 0 R /DA (/Helv 24 Tf 0 g) >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/Encoding /WinAnsiEncoding >>",
    ]
    output = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref_offset = len(output)
    output += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        output += b"%010d 00000 n \n" % offset
    output += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1)
    output += b"startxref\n%d\n%%%%EOF\n" % xref_offset
    return bytes(output)


# Görselin verilen bölgesindeki koyu piksel sayısını döndürür.
def _dark_pixels(image: Image.Image, box: tuple[int, int, int, int]) -> int:
    return sum(image.crop(box).convert("L").histogram()[:128])


# Verilen türde küçük, düz renkli örnek bir belge üretir.
def _sample(kind: str) -> bytes:
    if kind == "PDF":
        return _pdf([RED])
    return _encode(Image.new("RGB", (40, 30), RED), kind)


# Data URL'i doğrulayıp çözer ve RGB JPEG görsel olarak açar.
def _decode(url: str) -> Image.Image:
    assert url.startswith(DATA_URL_PREFIX)
    raw = base64.b64decode(url.removeprefix(DATA_URL_PREFIX), validate=True)
    image = Image.open(io.BytesIO(raw))
    image.load()
    assert image.format == "JPEG"
    assert image.mode == "RGB"
    return image


# Rengin her kanalda beklenen değere tolerans içinde yakın olduğunu doğrular.
def _assert_color(actual: Any, expected: tuple[int, int, int]) -> None:
    differences = [abs(a - e) for a, e in zip(actual, expected, strict=True)]
    assert max(differences) <= COLOR_TOLERANCE, (actual, expected)


# Görselin orta noktasındaki rengi döndürür.
def _center(image: Image.Image) -> Any:
    return image.getpixel((image.width // 2, image.height // 2))


# Çağrının fırlattığı PermanentError'ın içerik taşımayan kodunu döndürür.
async def _error_code(content: bytes, mime_type: str) -> str:
    with pytest.raises(PermanentError) as info:
        await prepare_images(content, mime_type)
    assert str(info.value) == info.value.code
    assert info.value.__cause__ is None
    return info.value.code


# Verilen hatayı fırlatan bir yerine koyma fonksiyonu üretir.
def _raiser(error: BaseException) -> Callable[..., Any]:
    # Her çağrıda verilen hatayı fırlatır.
    def raise_error(*args: Any, **kwargs: Any) -> Any:
        raise error

    return raise_error


# Sayfa renklerini sırayla tekrarlayarak istenen sayıda sayfa rengi döndürür.
def _page_colors(count: int) -> list[tuple[int, int, int]]:
    return [PAGE_COLORS[index % len(PAGE_COLORS)] for index in range(count)]


# Sabitlerin kararlaştırılan değerlerle aynı olduğunu doğrular; sayfa sınırı 8'dir.
def test_constants_match_contract() -> None:
    assert SUPPORTED_MIME_TYPES == (PDF, JPEG, PNG)
    assert MAX_PDF_PAGES == 8
    assert PDF_RENDER_SCALE == 2
    assert MAX_LONG_SIDE == 2048
    assert JPEG_QUALITY == 85


# Geçerli PDF'in her sayfası için sayfa sırasıyla bir görsel verildiğini doğrular.
@pytest.mark.parametrize("page_count", [1, 3, 8])
async def test_pdf_pages_returned_in_order(page_count: int) -> None:
    colors = _page_colors(page_count)

    urls = await prepare_images(_pdf(colors), PDF)

    assert len(urls) == page_count
    for url, color in zip(urls, colors, strict=True):
        _assert_color(_center(_decode(url)), color)


# 9 ve daha uzun PDF'in sayfa yüklenmeden TOO_MANY_PAGES verdiğini doğrular.
@pytest.mark.parametrize("page_count", [9, 10, 11])
async def test_pdf_over_page_limit_rejected_before_render(
    pdfium_spy: PdfiumSpy, page_count: int
) -> None:
    colors = _page_colors(page_count)

    assert await _error_code(_pdf(colors), PDF) == TOO_MANY_PAGES
    assert pdfium_spy.pages == []
    assert pdfium_spy.bitmaps == []


# Bozuk, boş ve sayfasız PDF içeriğinin UNREADABLE_DOCUMENT verdiğini doğrular.
@pytest.mark.parametrize(
    "content",
    [b"", b"bozuk-icerik-0123456789", b"%PDF-1.7\n%%EOF\n", ZERO_PAGE_PDF],
    ids=["bos", "rastgele", "yalnizca-baslik", "sifir-sayfa"],
)
async def test_broken_pdf_unreadable(content: bytes) -> None:
    assert await _error_code(content, PDF) == UNREADABLE_DOCUMENT


# Sayfa sayısı 0 okunursa belgenin kapatılıp UNREADABLE_DOCUMENT verildiğini doğrular.
async def test_pdf_with_zero_page_count_unreadable(
    monkeypatch: pytest.MonkeyPatch, pdfium_spy: PdfiumSpy
) -> None:
    with monkeypatch.context() as patch:
        patch.setattr(pdfium.PdfDocument, "__len__", lambda self: 0)
        assert await _error_code(_pdf([RED]), PDF) == UNREADABLE_DOCUMENT

    assert pdfium_spy.events == ["init_forms"]
    assert len(pdfium_spy.documents) == 1
    assert pdfium_spy.documents[0].raw is None
    assert pdfium_spy.pages == []
    urls = await prepare_images(_pdf([RED]), PDF)
    _assert_color(_center(_decode(urls[0])), RED)


# Sayfa boyutu geçersizse render edilmeden UNREADABLE_DOCUMENT verildiğini doğrular.
@pytest.mark.parametrize(
    "size",
    [
        pytest.param((0.0, 842.0), id="sifir-genislik"),
        pytest.param((595.0, 0.0), id="sifir-yukseklik"),
        pytest.param((-595.0, 842.0), id="negatif"),
        pytest.param((math.inf, 842.0), id="sonsuz"),
        pytest.param((595.0, math.nan), id="nan"),
    ],
)
async def test_pdf_page_with_invalid_size_unreadable(
    monkeypatch: pytest.MonkeyPatch,
    pdfium_spy: PdfiumSpy,
    size: tuple[float, float],
) -> None:
    with monkeypatch.context() as patch:
        patch.setattr(pdfium.PdfPage, "get_size", lambda self: size)
        assert await _error_code(_pdf([RED]), PDF) == UNREADABLE_DOCUMENT

    assert pdfium_spy.events == ["init_forms", "len", "get_page"]
    assert pdfium_spy.bitmaps == []
    objects = [*pdfium_spy.documents, *pdfium_spy.pages]
    assert len(objects) == 2
    assert all(item.raw is None for item in objects)
    urls = await prepare_images(_pdf([RED]), PDF)
    _assert_color(_center(_decode(urls[0])), RED)


# A4 boyutlu sayfanın scale=2 ile render edildiğini doğrular.
async def test_a4_page_rendered_at_scale_two(pdfium_spy: PdfiumSpy) -> None:
    urls = await prepare_images(_pdf([BLUE], size=(595, 842)), PDF)

    assert pdfium_spy.scales == [PDF_RENDER_SCALE]
    assert _decode(urls[0]).size == (1190, 1684)


# Çok büyük sayfanın uzun kenarı 2048'i aşmayacak ölçekle render edildiğini doğrular.
async def test_oversized_page_rendered_within_long_side(
    pdfium_spy: PdfiumSpy,
) -> None:
    content = _pdf([BLUE], size=(100, 150), resolution=1.0)

    urls = await prepare_images(content, PDF)

    assert pdfium_spy.scales == [pytest.approx(MAX_LONG_SIDE / 10800)]
    width, height = _decode(urls[0]).size
    assert max(width, height) == MAX_LONG_SIDE
    assert width / height == pytest.approx(100 / 150, abs=0.01)


# Belge, sayfa ve bitmap nesnelerinin başarıda ve hatada kapandığını doğrular.
async def test_pdfium_objects_closed(pdfium_spy: PdfiumSpy) -> None:
    await prepare_images(_pdf(PAGE_COLORS[:3]), PDF)
    with pytest.raises(PermanentError):
        await prepare_images(_pdf(_page_colors(9)), PDF)

    assert len(pdfium_spy.documents) == 2
    assert len(pdfium_spy.pages) == 3
    assert len(pdfium_spy.bitmaps) == 3
    objects = [*pdfium_spy.documents, *pdfium_spy.pages, *pdfium_spy.bitmaps]
    assert all(item.raw is None for item in objects)


# Eş zamanlı iki PDF'in doğru render edildiğini ve kilitle sıralandığını doğrular.
async def test_concurrent_pdf_renders_serialized(pdfium_spy: PdfiumSpy) -> None:
    first_colors = PAGE_COLORS[:3]
    second_colors = PAGE_COLORS[3:6]

    first, second = await asyncio.gather(
        prepare_images(_pdf(first_colors), PDF),
        prepare_images(_pdf(second_colors), PDF),
    )

    for urls, colors in ((first, first_colors), (second, second_colors)):
        assert len(urls) == len(colors)
        for url, color in zip(urls, colors, strict=True):
            _assert_color(_center(_decode(url)), color)
    assert len(pdfium_spy.scales) == 6
    assert pdfium_spy.max_active == 1


# Formların sayfalardan önce kurulduğunu, alan değerinin çizildiğini doğrular.
async def test_pdf_form_field_value_drawn(pdfium_spy: PdfiumSpy) -> None:
    image = _decode((await prepare_images(_form_pdf(), PDF))[0])

    assert image.size == FORM_PAGE_SIZE
    assert _dark_pixels(image, FORM_FIELD_BOX) > 500
    assert pdfium_spy.events == ["init_forms", "len", "get_page"]
    assert len(pdfium_spy.formenvs) == 1
    assert pdfium_spy.formenvs[0].raw is None


# Form desteği ya da form çizimi kapalıyken alan bölgesinin boş kaldığını doğrular.
@pytest.mark.parametrize("disabled", ["init_forms", "may_draw_forms"])
async def test_pdf_form_field_blank_without_form_drawing(
    monkeypatch: pytest.MonkeyPatch, disabled: str
) -> None:
    if disabled == "init_forms":
        monkeypatch.setattr(
            pdfium.PdfDocument, "init_forms", lambda self, config=None: False
        )
    else:
        original_render = pdfium.PdfPage.render
        monkeypatch.setattr(
            pdfium.PdfPage,
            "render",
            lambda self, **kwargs: original_render(
                self, **{**kwargs, "may_draw_forms": False}
            ),
        )

    image = _decode((await prepare_images(_form_pdf(), PDF))[0])

    assert image.size == FORM_PAGE_SIZE
    assert _dark_pixels(image, FORM_FIELD_BOX) == 0


# Formsuz PDF'te form ortamı kurulmadığını ve çıktının değişmediğini doğrular.
async def test_formless_pdf_output_unchanged(
    monkeypatch: pytest.MonkeyPatch, pdfium_spy: PdfiumSpy
) -> None:
    content = _pdf(PAGE_COLORS[:3])

    with_forms = await prepare_images(content, PDF)
    monkeypatch.setattr(
        pdfium.PdfDocument, "init_forms", lambda self, config=None: False
    )
    without_forms = await prepare_images(content, PDF)

    assert pdfium_spy.events.count("init_forms") == 1
    assert pdfium_spy.formenvs == []
    assert with_forms == without_forms


# init_forms hata verirse belgenin kapatılıp UNREADABLE_DOCUMENT verildiğini doğrular.
async def test_init_forms_failure_unreadable(
    monkeypatch: pytest.MonkeyPatch, pdfium_spy: PdfiumSpy
) -> None:
    monkeypatch.setattr(
        pdfium.PdfDocument, "init_forms", _raiser(pdfium.PdfiumError("x"))
    )

    assert await _error_code(_form_pdf(), PDF) == UNREADABLE_DOCUMENT
    assert len(pdfium_spy.documents) == 1
    assert pdfium_spy.documents[0].raw is None
    assert pdfium_spy.pages == []


# Geçerli JPEG ve PNG'nin boyutu ve rengi korunmuş tek görsel verdiğini doğrular.
@pytest.mark.parametrize(("image_format", "mime_type"), [("JPEG", JPEG), ("PNG", PNG)])
async def test_valid_image_returns_single_page(
    image_format: str, mime_type: str
) -> None:
    content = _encode(Image.new("RGB", (300, 200), RED), image_format)

    urls = await prepare_images(content, mime_type)

    assert len(urls) == 1
    image = _decode(urls[0])
    assert image.size == (300, 200)
    _assert_color(_center(image), RED)


# Şeffaf PNG'nin şeffaf bölgesinin beyaz zemine oturtulduğunu doğrular.
@pytest.mark.parametrize("mode", ["RGBA", "P"])
async def test_transparent_png_flattened_on_white(mode: str) -> None:
    if mode == "RGBA":
        source = Image.new("RGBA", (100, 50), (*RED, 255))
        source.paste((0, 0, 0, 0), (0, 0, 50, 50))
        content = _encode(source, "PNG")
    else:
        source = Image.new("P", (100, 50), 1)
        source.putpalette([0, 0, 0, *RED])
        source.paste(0, (0, 0, 50, 50))
        content = _encode(source, "PNG", transparency=0)

    image = _decode((await prepare_images(content, PNG))[0])

    _assert_color(image.getpixel((25, 25)), WHITE)
    _assert_color(image.getpixel((75, 25)), RED)


# EXIF yön etiketi 6 olan JPEG'in saat yönünde 90 derece döndürüldüğünü doğrular.
async def test_exif_orientation_six_rotated() -> None:
    source = Image.new("RGB", (200, 100), RED)
    source.paste(BLUE, (100, 0, 200, 100))
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = 6
    content = _encode(source, "JPEG", exif=exif.tobytes())

    image = _decode((await prepare_images(content, JPEG))[0])

    assert image.size == (100, 200)
    _assert_color(image.getpixel((50, 50)), RED)
    _assert_color(image.getpixel((50, 150)), BLUE)


# Uzun kenarı 2048'i aşan görselin oranı korunarak küçültüldüğünü doğrular.
@pytest.mark.parametrize(
    ("image_format", "mime_type", "size", "expected"),
    [
        ("JPEG", JPEG, (4000, 3000), (2048, 1536)),
        ("PNG", PNG, (4000, 3000), (2048, 1536)),
        ("JPEG", JPEG, (4096, 3072), (2048, 1536)),
        ("JPEG", JPEG, (1000, 5000), (410, 2048)),
    ],
)
async def test_large_image_downscaled(
    image_format: str,
    mime_type: str,
    size: tuple[int, int],
    expected: tuple[int, int],
) -> None:
    content = _encode(Image.new("RGB", size, BLUE), image_format)

    image = _decode((await prepare_images(content, mime_type))[0])

    assert image.size == expected
    _assert_color(_center(image), BLUE)


# Uzun kenarı sınırı aşmayan görselin büyütülmediğini doğrular.
@pytest.mark.parametrize("size", [(50, 30), (2048, 1000)])
async def test_small_image_not_upscaled(size: tuple[int, int]) -> None:
    content = _encode(Image.new("RGB", size, RED), "PNG")

    image = _decode((await prepare_images(content, PNG))[0])

    assert image.size == size


# Farklı renk kiplerindeki görsellerin RGB JPEG'e çevrildiğini doğrular.
@pytest.mark.parametrize(
    ("image_format", "mode"),
    [
        ("JPEG", "L"),
        ("JPEG", "CMYK"),
        ("PNG", "1"),
        ("PNG", "L"),
        ("PNG", "P"),
        ("PNG", "I;16"),
        ("PNG", "LA"),
    ],
)
async def test_color_modes_normalized_to_rgb(image_format: str, mode: str) -> None:
    content = _encode(Image.new(mode, (40, 30)), image_format)
    mime_type = JPEG if image_format == "JPEG" else PNG

    image = _decode((await prepare_images(content, mime_type))[0])

    assert image.size == (40, 30)


# Pillow piksel sınırını ya da uyarı eşiğini aşan görselin reddedildiğini doğrular.
@pytest.mark.parametrize(("image_format", "mime_type"), [("JPEG", JPEG), ("PNG", PNG)])
@pytest.mark.parametrize("size", [(150, 100), (300, 100)], ids=["uyari", "hata"])
async def test_pixel_limit_exceeded_unreadable(
    monkeypatch: pytest.MonkeyPatch,
    image_format: str,
    mime_type: str,
    size: tuple[int, int],
) -> None:
    content = _encode(Image.new("RGB", size, RED), image_format)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10_000)

    assert await _error_code(content, mime_type) == UNREADABLE_DOCUMENT


# mime_type ile gerçek içerik uyuşmadığında UNREADABLE_DOCUMENT verildiğini doğrular.
@pytest.mark.parametrize(
    ("kind", "mime_type"),
    [
        ("PNG", JPEG),
        ("JPEG", PNG),
        ("PDF", PNG),
        ("PDF", JPEG),
        ("PNG", PDF),
        ("JPEG", PDF),
    ],
)
async def test_mime_type_mismatch_unreadable(kind: str, mime_type: str) -> None:
    assert await _error_code(_sample(kind), mime_type) == UNREADABLE_DOCUMENT


# Desteklenmeyen mime_type'ın UNSUPPORTED_MIME_TYPE verdiğini doğrular.
@pytest.mark.parametrize(
    "mime_type", ["image/gif", "image/jpg", "IMAGE/PNG", "text/plain", ""]
)
async def test_unsupported_mime_type(mime_type: str) -> None:
    assert await _error_code(_sample("PNG"), mime_type) == UNSUPPORTED_MIME_TYPE


# Çıktının girdideki EXIF ve yorum gibi meta verileri taşımadığını doğrular.
async def test_output_has_no_input_metadata() -> None:
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "OrnekKamera"
    content = _encode(
        Image.new("RGB", (40, 30), RED),
        "JPEG",
        exif=exif.tobytes(),
        comment=b"ornek-yorum",
    )

    image = _decode((await prepare_images(content, JPEG))[0])

    assert "exif" not in image.info
    assert "comment" not in image.info
    assert len(image.getexif()) == 0


# Beklenmeyen kütüphane hatalarının UNREADABLE_DOCUMENT'e çevrildiğini doğrular.
@pytest.mark.parametrize("kind", ["PDF", "PNG"])
async def test_unexpected_library_error_unreadable(
    monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    if kind == "PDF":
        monkeypatch.setattr(pdfium.PdfPage, "render", _raiser(RuntimeError("x")))
    else:
        monkeypatch.setattr(ImageOps, "exif_transpose", _raiser(RuntimeError("x")))
    mime_type = PDF if kind == "PDF" else PNG

    assert await _error_code(_sample(kind), mime_type) == UNREADABLE_DOCUMENT


# Bellek ve programlama hatalarının UNREADABLE_DOCUMENT'e çevrilmediğini doğrular.
@pytest.mark.parametrize("kind", ["PDF", "PNG"])
@pytest.mark.parametrize("error_type", [MemoryError, TypeError, AttributeError])
async def test_memory_and_programming_errors_not_hidden(
    monkeypatch: pytest.MonkeyPatch, kind: str, error_type: type[Exception]
) -> None:
    if kind == "PDF":
        monkeypatch.setattr(pdfium.PdfPage, "render", _raiser(error_type()))
    else:
        monkeypatch.setattr(ImageOps, "exif_transpose", _raiser(error_type()))
    mime_type = PDF if kind == "PDF" else PNG

    with pytest.raises(error_type):
        await prepare_images(_sample(kind), mime_type)
