from dataclasses import FrozenInstanceError
from datetime import date, timedelta

import pytest

from app.assessments.analyze import (
    DUE_SOON_DAYS,
    STATUS_HIGH,
    STATUS_LOW,
    STATUS_NORMAL,
    STATUS_UNKNOWN,
    TREND_WINDOW,
    Analysis,
    ReferenceRange,
    SeriesFinding,
    VaccinationReminderInfo,
    analyze,
    parse_number,
    parse_reference_range,
)
from app.generated import events_pb2, medical_record_pb2

AS_OF = date(2026, 11, 2)
CRITICAL_PERCENT = 50.0


# Verilen alanlarla tek bir tahlil ölçümü kurar.
def measurement(
    sampled_at: str,
    value: str,
    *,
    reference_range: str = "",
    unit: str = "",
    flag: int = medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED,
) -> events_pb2.LabMeasurement:
    return events_pb2.LabMeasurement(
        sampled_at=sampled_at,
        value=value,
        unit=unit,
        reference_range=reference_range,
        flag=flag,
    )


# Verilen ölçümlerle bir tahlil serisi kurar.
def series(
    test_name: str, *measurements: events_pb2.LabMeasurement
) -> events_pb2.LabSeries:
    return events_pb2.LabSeries(test_name=test_name, measurements=measurements)


# Verilen ad ve tarihlerle bir aşı ayrıntısı kurar.
def vaccination(
    name: str, administered_at: str, next_due_at: str
) -> medical_record_pb2.VaccinationDetails:
    return medical_record_pb2.VaccinationDetails(
        vaccine_name=name, administered_at=administered_at, next_due_at=next_due_at
    )


# Seri ve aşılarla bir sağlık değerlendirmesi isteği kurar.
def request(
    *lab_series: events_pb2.LabSeries,
    vaccinations: tuple[medical_record_pb2.VaccinationDetails, ...] = (),
) -> events_pb2.HealthAssessmentRequested:
    return events_pb2.HealthAssessmentRequested(
        request_id="istek-1",
        as_of=AS_OF.isoformat(),
        species="CAT",
        lab_series=lab_series,
        vaccinations=vaccinations,
    )


# Tek seriyi inceleyip çıkan tek bulguyu döndürür.
def single_finding(
    lab_series: events_pb2.LabSeries, percent: float = CRITICAL_PERCENT
) -> SeriesFinding:
    result = analyze(request(lab_series), AS_OF, critical_deviation_percent=percent)
    assert len(result.findings) == 1
    return result.findings[0]


# Tek değerli ve aralıklı bir seriden bulguyu döndürür.
def finding_for(
    value: str,
    reference_range: str,
    *,
    flag: int = medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED,
    percent: float = CRITICAL_PERCENT,
) -> SeriesFinding:
    return single_finding(
        series(
            "ALT",
            measurement(
                "2026-10-01", value, reference_range=reference_range, flag=flag
            ),
        ),
        percent,
    )


# Verilen değerlerle sırayla tarihlenmiş ölçümlerden serinin eğilimini döndürür.
def trend_of(*values: str) -> int:
    measurements = tuple(
        measurement(f"2026-10-{day:02d}", value)
        for day, value in enumerate(values, start=1)
    )
    return single_finding(series("ALT", *measurements)).trend


# Aşıları inceleyip hatırlatmaları döndürür.
def reminders_for(
    *vaccinations: medical_record_pb2.VaccinationDetails,
) -> tuple[VaccinationReminderInfo, ...]:
    return analyze(
        request(vaccinations=vaccinations),
        AS_OF,
        critical_deviation_percent=CRITICAL_PERCENT,
    ).reminders


# Eşik ve pencere sabitlerinin beklenen değerlerde olduğunu doğrular.
def test_constants() -> None:
    assert (STATUS_LOW, STATUS_HIGH, STATUS_NORMAL, STATUS_UNKNOWN) == (
        "LOW",
        "HIGH",
        "NORMAL",
        "UNKNOWN",
    )
    assert DUE_SOON_DAYS == 30
    assert TREND_WINDOW == 3


# Nokta ya da virgüllü ondalık, eksi işareti ve boşlukların doğru çözüldüğünü doğrular.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("12", 12.0, id="tam-sayi"),
        pytest.param("12,5", 12.5, id="virgul"),
        pytest.param("0.8", 0.8, id="nokta"),
        pytest.param("-1", -1.0, id="eksi"),
        pytest.param("-0,25", -0.25, id="eksi-virgul"),
        pytest.param("  7.5  ", 7.5, id="bosluklu"),
        pytest.param(" 3 ", 3.0, id="bolunmez-bosluk"),
        pytest.param("007", 7.0, id="bastaki-sifir"),
        pytest.param("0", 0.0, id="sifir"),
    ],
)
def test_parse_number_accepts_valid_forms(value: str, expected: float) -> None:
    assert parse_number(value) == expected


# Sayı olmayan, işaretli, binlik ayraçlı ve üslü biçimlerin reddedildiğini doğrular.
@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="bos"),
        pytest.param("   ", id="yalnizca-bosluk"),
        pytest.param("<0.1", id="kucuktur"),
        pytest.param(">500", id="buyuktur"),
        pytest.param("pozitif", id="metin"),
        pytest.param("1.234,5", id="binlik-ayrac"),
        pytest.param("1,2,3", id="iki-virgul"),
        pytest.param("12 5", id="ara-bosluk"),
        pytest.param("nan", id="nan"),
        pytest.param("inf", id="inf"),
        pytest.param("-inf", id="eksi-inf"),
        pytest.param("1e3", id="us"),
        pytest.param("1E-3", id="buyuk-us"),
        pytest.param("+5", id="arti"),
        pytest.param("--5", id="cift-eksi"),
        pytest.param("- 5", id="eksiden-sonra-bosluk"),
        pytest.param(".5", id="tam-kisimsiz"),
        pytest.param("5.", id="ondaliksiz"),
        pytest.param("12 mg", id="birimli"),
        pytest.param("١٢", id="arapca-rakam"),
        pytest.param("１２", id="genis-rakam"),
    ],
)
def test_parse_number_rejects_invalid_forms(value: str) -> None:
    assert parse_number(value) is None


# Sonsuza taşan çok uzun bir sayının reddedildiğini doğrular.
def test_parse_number_rejects_overflowing_value() -> None:
    assert parse_number("9" * 400) is None


# Tire, uzun çizgiler, virgül ve boşluklarla yazılmış aralıkların çözüldüğünü doğrular.
@pytest.mark.parametrize(
    ("value", "low", "high"),
    [
        pytest.param("5.5-8.5", 5.5, 8.5, id="tire"),
        pytest.param("5,5 - 8,5", 5.5, 8.5, id="virgul-bosluklu"),
        pytest.param("37–55", 37.0, 55.0, id="en-cizgi"),
        pytest.param("37 — 55", 37.0, 55.0, id="em-cizgi"),
        pytest.param("  0-10  ", 0.0, 10.0, id="dis-bosluk"),
        pytest.param("0-0.1", 0.0, 0.1, id="dar-aralik"),
    ],
)
def test_parse_reference_range_accepts_valid_forms(
    value: str, low: float, high: float
) -> None:
    assert parse_reference_range(value) == ReferenceRange(low, high)


# Eksik, ters, eşit, negatif sınırlı ve çok ayraçlı aralıkların reddedildiğini doğrular.
@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="bos"),
        pytest.param("5.5", id="tek-sayi"),
        pytest.param("5.5-", id="ust-sinir-yok"),
        pytest.param("-8.5", id="alt-sinir-yok"),
        pytest.param("8.5-5.5", id="ters"),
        pytest.param("5-5", id="esit"),
        pytest.param("-1-5", id="negatif-alt-sinir"),
        pytest.param("1--5", id="negatif-ust-sinir"),
        pytest.param("1-5-9", id="iki-ayrac"),
        pytest.param("1–-5", id="karisik-ayrac"),
        pytest.param("<5", id="kucuktur"),
        pytest.param("1 / 5", id="egik-cizgi"),
        pytest.param("1 ile 5", id="metin"),
        pytest.param("a-b", id="sayi-olmayan"),
        pytest.param("1.234,5-2000", id="binlik-ayrac"),
    ],
)
def test_parse_reference_range_rejects_invalid_forms(value: str) -> None:
    assert parse_reference_range(value) is None


# Durumun ve aralık genişliğine göre sapma yüzdesinin hesaplandığını doğrular.
@pytest.mark.parametrize(
    ("value", "status", "deviation"),
    [
        pytest.param("5", STATUS_LOW, 50.0, id="altinda"),
        pytest.param("9,5", STATUS_LOW, 5.0, id="az-altinda"),
        pytest.param("10", STATUS_NORMAL, 0.0, id="alt-sinirda"),
        pytest.param("15", STATUS_NORMAL, 0.0, id="icinde"),
        pytest.param("20", STATUS_NORMAL, 0.0, id="ust-sinirda"),
        pytest.param("21", STATUS_HIGH, 10.0, id="az-ustunde"),
        pytest.param("40", STATUS_HIGH, 200.0, id="cok-ustunde"),
        pytest.param("-10", STATUS_LOW, 200.0, id="negatif-deger"),
    ],
)
def test_status_and_deviation_come_from_reference_range(
    value: str, status: str, deviation: float
) -> None:
    finding = finding_for(value, "10-20")

    assert finding.status == status
    assert finding.deviation_percent == pytest.approx(deviation)


# Değer ve aralık çözülebildiğinde etiketin yok sayıldığını doğrular.
@pytest.mark.parametrize(
    ("value", "flag", "status"),
    [
        pytest.param("5", medical_record_pb2.HIGH, STATUS_LOW, id="dusuk-ama-high"),
        pytest.param("25", medical_record_pb2.LOW, STATUS_HIGH, id="yuksek-ama-low"),
        pytest.param(
            "15", medical_record_pb2.HIGH, STATUS_NORMAL, id="normal-ama-high"
        ),
    ],
)
def test_reference_range_wins_over_flag(value: str, flag: int, status: str) -> None:
    assert finding_for(value, "10-20", flag=flag).status == status


# Değer ya da aralık çözülemezse durumun etiketten alınıp sapma olmadığını doğrular.
@pytest.mark.parametrize(
    ("value", "reference_range"),
    [
        pytest.param("pozitif", "10-20", id="deger-cozulemez"),
        pytest.param("15", "", id="aralik-bos"),
        pytest.param("15", "<20", id="aralik-cozulemez"),
        pytest.param("<0.1", "negatif", id="ikisi-de-cozulemez"),
    ],
)
@pytest.mark.parametrize(
    ("flag", "status"),
    [
        pytest.param(medical_record_pb2.LOW, STATUS_LOW, id="low"),
        pytest.param(medical_record_pb2.HIGH, STATUS_HIGH, id="high"),
        pytest.param(medical_record_pb2.NORMAL, STATUS_NORMAL, id="normal"),
        pytest.param(
            medical_record_pb2.LAB_RESULT_FLAG_UNSPECIFIED,
            STATUS_UNKNOWN,
            id="belirtilmemis",
        ),
        pytest.param(99, STATUS_UNKNOWN, id="bilinmeyen-deger"),
    ],
)
def test_status_falls_back_to_flag(
    value: str, reference_range: str, flag: int, status: str
) -> None:
    finding = finding_for(value, reference_range, flag=flag, percent=0.001)

    assert finding.status == status
    assert finding.deviation_percent is None
    assert finding.critical is False


# Kritikliğin sapma yüzdesi eşiği kesin olarak aştığında verildiğini doğrular.
@pytest.mark.parametrize(
    ("value", "reference_range", "percent", "critical"),
    [
        pytest.param("15", "0-10", 50.0, False, id="tam-esikte-ustte"),
        pytest.param("5", "10-20", 50.0, False, id="tam-esikte-altta"),
        pytest.param("15,00001", "0-10", 50.0, True, id="esigin-hemen-ustunde"),
        pytest.param("4.99999", "10-20", 50.0, True, id="esigin-hemen-altinda"),
        pytest.param("14.99999", "0-10", 50.0, False, id="esigin-hemen-icinde"),
        pytest.param("12", "0-10", 10.0, True, id="ozel-esik-asildi"),
        pytest.param("12", "0-10", 25.0, False, id="ozel-esik-asilmadi"),
        pytest.param("10", "0-10", 0.0001, False, id="sinirdaki-deger"),
        pytest.param("5", "0-10", 0.0001, False, id="aralik-ici"),
    ],
)
def test_critical_requires_deviation_strictly_above_threshold(
    value: str, reference_range: str, percent: float, critical: bool
) -> None:
    assert finding_for(value, reference_range, percent=percent).critical is critical


# Eğilimin son sayısal ölçümlerin yönüne göre belirlendiğini doğrular.
@pytest.mark.parametrize(
    ("values", "trend"),
    [
        pytest.param(("5",), medical_record_pb2.LAB_TREND_SINGLE, id="tek-olcum"),
        pytest.param(("5", "6"), medical_record_pb2.LAB_TREND_RISING, id="iki-artan"),
        pytest.param(("6", "5"), medical_record_pb2.LAB_TREND_FALLING, id="iki-azalan"),
        pytest.param(("5", "5"), medical_record_pb2.LAB_TREND_STABLE, id="iki-esit"),
        pytest.param(
            ("1", "2", "3"), medical_record_pb2.LAB_TREND_RISING, id="uc-artan"
        ),
        pytest.param(
            ("3", "2", "1"), medical_record_pb2.LAB_TREND_FALLING, id="uc-azalan"
        ),
        pytest.param(
            ("1", "3", "2"), medical_record_pb2.LAB_TREND_STABLE, id="karisik"
        ),
        pytest.param(
            ("1", "2", "2"), medical_record_pb2.LAB_TREND_STABLE, id="artip-sabit"
        ),
        pytest.param(
            ("3", "2", "2"), medical_record_pb2.LAB_TREND_STABLE, id="azalip-sabit"
        ),
        pytest.param(
            ("9", "1", "2", "3"),
            medical_record_pb2.LAB_TREND_RISING,
            id="yalnizca-son-uc",
        ),
        pytest.param(
            ("1", "2", "3", "0"),
            medical_record_pb2.LAB_TREND_STABLE,
            id="son-uc-karisik",
        ),
        pytest.param(
            ("1", "pozitif", "2", "<5"),
            medical_record_pb2.LAB_TREND_RISING,
            id="sayisal-olmayan-atlanir",
        ),
        pytest.param(
            ("5", "6", "pozitif", "7", "negatif"),
            medical_record_pb2.LAB_TREND_RISING,
            id="son-uc-sayisal",
        ),
        pytest.param(
            ("4", "1", "2", "pozitif", "3"),
            medical_record_pb2.LAB_TREND_RISING,
            id="pencere-sayisallarla",
        ),
        pytest.param(
            ("pozitif", "7"),
            medical_record_pb2.LAB_TREND_SINGLE,
            id="tek-sayisal",
        ),
        pytest.param(
            ("pozitif",),
            medical_record_pb2.LAB_TREND_SINGLE,
            id="tek-sayisal-olmayan",
        ),
        pytest.param(
            ("pozitif", "negatif"),
            medical_record_pb2.LAB_TREND_UNSPECIFIED,
            id="hic-sayisal-yok",
        ),
        pytest.param(
            ("1,5", "1.6"),
            medical_record_pb2.LAB_TREND_RISING,
            id="virgul-ve-nokta",
        ),
    ],
)
def test_trend_uses_last_numeric_values(values: tuple[str, ...], trend: int) -> None:
    assert trend_of(*values) == trend


# Ölçümlerin tarihe göre sıralanıp en sonuncusunun bulguya yazıldığını doğrular.
def test_measurements_are_sorted_by_sampled_at() -> None:
    finding = single_finding(
        series(
            "  Kreatinin  ",
            measurement("2026-10-20", " 3 ", reference_range=" 0-2 ", unit=" mg/dL "),
            measurement("2026-08-01", "1", reference_range="0-4", unit="g/L"),
            measurement("2026-09-15", "2", reference_range="0-4", unit="g/L"),
        )
    )

    assert finding == SeriesFinding(
        test_name="Kreatinin",
        latest_value="3",
        unit="mg/dL",
        reference_range="0-2",
        status=STATUS_HIGH,
        deviation_percent=50.0,
        trend=medical_record_pb2.LAB_TREND_RISING,
        critical=False,
        measurement_count=3,
    )


# Aynı tarihli ölçümlerde istek sırasının korunup sonuncusunun alındığını doğrular.
def test_same_date_measurements_keep_request_order() -> None:
    finding = single_finding(
        series(
            "ALT",
            measurement("2026-10-01", "1"),
            measurement("2026-10-01", "2"),
            measurement("2026-09-01", "3"),
        )
    )

    assert finding.latest_value == "2"
    assert finding.trend == medical_record_pb2.LAB_TREND_STABLE


# Ölçümsüz serilerin atlandığını, diğerlerinin istek sırasıyla geldiğini doğrular.
def test_empty_series_are_skipped_and_order_is_kept() -> None:
    result = analyze(
        request(
            series("Boş seri"),
            series("ALT", measurement("2026-10-01", "1")),
            series("Boş seri 2"),
            series("GGT", measurement("2026-10-01", "2")),
        ),
        AS_OF,
        critical_deviation_percent=CRITICAL_PERCENT,
    )

    assert [finding.test_name for finding in result.findings] == ["ALT", "GGT"]
    assert [finding.measurement_count for finding in result.findings] == [1, 1]


# İstekte seri ve aşı yoksa boş ve kritik olmayan bir sonuç verildiğini doğrular.
def test_empty_request_gives_empty_analysis() -> None:
    result = analyze(request(), AS_OF, critical_deviation_percent=CRITICAL_PERCENT)

    assert result == Analysis(findings=(), reminders=(), has_critical=False)


# Kritik bulgu varsa has_critical'ın True, yoksa False olduğunu doğrular.
@pytest.mark.parametrize(
    ("second_value", "has_critical"),
    [
        pytest.param("30", True, id="kritik-var"),
        pytest.param("21", False, id="kritik-yok"),
    ],
)
def test_has_critical_reflects_findings(second_value: str, has_critical: bool) -> None:
    result = analyze(
        request(
            series("ALT", measurement("2026-10-01", "15", reference_range="10-20")),
            series(
                "GGT",
                measurement("2026-10-01", second_value, reference_range="10-20"),
            ),
        ),
        AS_OF,
        critical_deviation_percent=CRITICAL_PERCENT,
    )

    assert result.has_critical is has_critical
    assert [finding.critical for finding in result.findings] == [False, has_critical]


# Sonraki aşı tarihinin bugüne göre gecikmiş, yaklaşan ya da uzak sayıldığını doğrular.
@pytest.mark.parametrize(
    ("days", "status"),
    [
        pytest.param(-365, medical_record_pb2.VACCINATION_OVERDUE, id="cok-gecikmis"),
        pytest.param(-1, medical_record_pb2.VACCINATION_OVERDUE, id="dun"),
        pytest.param(0, medical_record_pb2.VACCINATION_DUE_SOON, id="bugun"),
        pytest.param(1, medical_record_pb2.VACCINATION_DUE_SOON, id="yarin"),
        pytest.param(
            DUE_SOON_DAYS, medical_record_pb2.VACCINATION_DUE_SOON, id="otuzuncu-gun"
        ),
        pytest.param(DUE_SOON_DAYS + 1, None, id="otuz-birinci-gun"),
        pytest.param(400, None, id="uzak"),
    ],
)
def test_reminder_status_depends_on_next_due_date(
    days: int, status: int | None
) -> None:
    due = (AS_OF + timedelta(days=days)).isoformat()

    reminders = reminders_for(vaccination(" Kuduz ", "2025-11-02", due))

    expected = (
        ()
        if status is None
        else (
            VaccinationReminderInfo(
                vaccine_name="Kuduz", next_due_at=due, status=status
            ),
        )
    )
    assert reminders == expected


# Boş ya da geçersiz bir sonraki aşı tarihinde hatırlatma verilmediğini doğrular.
@pytest.mark.parametrize(
    "next_due_at",
    [
        pytest.param("", id="bos"),
        pytest.param("2026-13-01", id="gecersiz-ay"),
        pytest.param("2026-02-30", id="gecersiz-gun"),
        pytest.param("01.11.2026", id="baska-bicim"),
        pytest.param(" 2026-11-01 ", id="bosluklu"),
        pytest.param("0999-01-01", id="cok-eski-yil"),
    ],
)
def test_missing_or_invalid_next_due_date_gives_no_reminder(next_due_at: str) -> None:
    assert reminders_for(vaccination("Kuduz", "2025-11-02", next_due_at)) == ()


# Aynı aşının harf duyarsız gruplanıp en son yapılan dozunun kullanıldığını doğrular.
def test_reminder_uses_latest_dose_of_case_insensitive_group() -> None:
    reminders = reminders_for(
        vaccination("KUDUZ", "2026-10-01", ""),
        vaccination("kuduz ", "2024-10-01", "2025-10-01"),
        vaccination(" Kuduz", "2025-10-01", "2026-10-01"),
    )

    assert reminders == ()


# Eski bir dozun gecikmiş tarihinin yeni dozla geçersiz kaldığını doğrular.
def test_newer_dose_replaces_overdue_reminder() -> None:
    reminders = reminders_for(
        vaccination("Kuduz", "2025-10-01", "2026-10-01"),
        vaccination("KUDUZ", "2026-10-15", "2026-11-20"),
    )

    assert reminders == (
        VaccinationReminderInfo(
            vaccine_name="KUDUZ",
            next_due_at="2026-11-20",
            status=medical_record_pb2.VACCINATION_DUE_SOON,
        ),
    )


# Aynı tarihli dozlarda istekte sonra gelenin seçildiğini doğrular.
def test_same_day_doses_pick_the_later_one_in_request() -> None:
    reminders = reminders_for(
        vaccination("Karma", "2026-10-01", "2026-10-30"),
        vaccination("karma", "2026-10-01", "2027-10-01"),
    )

    assert reminders == ()


# Hatırlatmaların grupların istekte ilk görüldüğü sırayla verildiğini doğrular.
def test_reminders_keep_first_appearance_order() -> None:
    reminders = reminders_for(
        vaccination("Karma", "2025-01-01", "2026-01-01"),
        vaccination("Kuduz", "2025-06-01", "2026-11-10"),
        vaccination("Uzak", "2026-10-01", "2027-10-01"),
        vaccination("KARMA", "2025-10-01", "2026-10-15"),
    )

    assert reminders == (
        VaccinationReminderInfo(
            vaccine_name="KARMA",
            next_due_at="2026-10-15",
            status=medical_record_pb2.VACCINATION_OVERDUE,
        ),
        VaccinationReminderInfo(
            vaccine_name="Kuduz",
            next_due_at="2026-11-10",
            status=medical_record_pb2.VACCINATION_DUE_SOON,
        ),
    )


# Sonuç veri sınıflarının değiştirilemez olduğunu doğrular.
def test_result_dataclasses_are_frozen() -> None:
    finding = finding_for("15", "10-20")

    with pytest.raises(FrozenInstanceError):
        finding.status = STATUS_HIGH
    with pytest.raises(FrozenInstanceError):
        ReferenceRange(1.0, 2.0).low = 0.0
