from types import MappingProxyType

import pytest

from app.assessments.analyze import (
    STATUS_HIGH,
    STATUS_LOW,
    STATUS_NORMAL,
    STATUS_UNKNOWN,
    Analysis,
    SeriesFinding,
    VaccinationReminderInfo,
)
from app.assessments.knowledge import (
    GUIDE_SOURCE_PENDING,
    PATTERNS,
    SYNONYMS,
    TEST_NAME_ALIASES,
    Pattern,
    canonical_test_name,
    normalize_test_name,
    triggered_patterns,
)
from app.generated import medical_record_pb2

PATTERN_IDS = (
    "anemia",
    "kidney",
    "liver",
    "glucose",
    "inflammation",
    "thyroid",
    "electrolyte",
    "vaccination",
)
PATTERN_TITLES = (
    "Anemi bulgusu",
    "Böbrek değerleri",
    "Karaciğer değerleri",
    "Kan şekeri",
    "Bağışıklık hücreleri",
    "Tiroid değeri",
    "Elektrolitler",
    "Aşı takvimi",
)
REMINDER = VaccinationReminderInfo(
    vaccine_name="Kuduz",
    next_due_at="2026-10-01",
    status=medical_record_pb2.VACCINATION_OVERDUE,
)
ALL_STATUSES = (STATUS_LOW, STATUS_HIGH, STATUS_NORMAL, STATUS_UNKNOWN)
FINDING_RULES = (
    ("anemia", ("HCT", "HGB", "RBC"), (STATUS_LOW,)),
    ("kidney", ("BUN", "UREA", "CREA", "SDMA"), (STATUS_HIGH,)),
    ("liver", ("ALT", "ALP", "GGT", "TBIL"), (STATUS_HIGH,)),
    ("glucose", ("GLU",), (STATUS_LOW, STATUS_HIGH)),
    ("inflammation", ("WBC", "NEU"), (STATUS_LOW, STATUS_HIGH)),
    ("electrolyte", ("NA", "K", "CA"), (STATUS_LOW, STATUS_HIGH)),
)


# Verilen test adı ve durumla bir tahlil bulgusu kurar.
def finding(test_name: str, status: str) -> SeriesFinding:
    return SeriesFinding(
        test_name=test_name,
        latest_value="1",
        unit="",
        reference_range="",
        status=status,
        deviation_percent=None,
        trend=medical_record_pb2.LAB_TREND_SINGLE,
        critical=False,
        measurement_count=1,
    )


# Bulgular ve hatırlatmalarla bir inceleme sonucu kurar.
def analysis_of(
    *findings: SeriesFinding,
    reminders: tuple[VaccinationReminderInfo, ...] = (),
) -> Analysis:
    return Analysis(findings=findings, reminders=reminders, has_critical=False)


# Tetiklenen kalıpların kimliklerini sırasıyla döndürür.
def triggered_ids(analysis: Analysis, species: str = "CAT") -> tuple[str, ...]:
    return tuple(pattern.id for pattern in triggered_patterns(analysis, species))


# Test adlarının aksansız, küçük harfli ve yalnızca harf ile rakam kaldığını doğrular.
@pytest.mark.parametrize(
    ("name", "expected"),
    [
        pytest.param("Lökosit (WBC)", "lokositwbc", id="lokosit"),
        pytest.param("Hematokrit", "hematokrit", id="hematokrit"),
        pytest.param("İdrar", "idrar", id="noktali-buyuk-i"),
        pytest.param("Total Bilirubin", "totalbilirubin", id="bosluklu"),
        pytest.param("K+", "k", id="isaretli"),
        pytest.param("KAN ŞEKERİ", "kansekeri", id="buyuk-harf"),
        pytest.param("Nötrofil", "notrofil", id="noktali-o"),
        pytest.param("Kalsıyum", "kalsiyum", id="noktasiz-i"),
        pytest.param("Gama-Glutamil Transferaz", "gamaglutamiltransferaz", id="tire"),
        pytest.param("T4", "t4", id="rakamli"),
        pytest.param("Üre", "ure", id="noktali-u"),
        pytest.param("Kan Üre Azotu", "kanureazotu", id="cok-kelimeli"),
        pytest.param("ｈｂ", "hb", id="genis-harf"),
        pytest.param("", "", id="bos"),
        pytest.param("—/()", "", id="yalnizca-isaret"),
    ],
)
def test_normalize_test_name(name: str, expected: str) -> None:
    assert normalize_test_name(name) == expected


# Eş anlamlılar tablosunun sözleşmedeki takma adları içerdiğini doğrular.
def test_aliases_match_contract() -> None:
    assert dict(TEST_NAME_ALIASES) == {
        "HCT": ("hct", "hematokrit", "hematocrit", "pcv"),
        "HGB": ("hgb", "hb", "hemoglobin"),
        "RBC": ("rbc", "eritrosit", "alyuvar"),
        "WBC": ("wbc", "lokosit", "akyuvar"),
        "NEU": ("neu", "neut", "notrofil", "neutrophil", "neutrophils"),
        "BUN": ("bun", "kanureazotu"),
        "UREA": ("ure", "urea"),
        "CREA": ("crea", "cre", "creat", "kreatinin", "creatinine"),
        "SDMA": ("sdma",),
        "ALT": ("alt", "sgpt", "alaninaminotransferaz"),
        "ALP": ("alp", "alkalenfosfataz", "alkalinfosfataz", "alkalinephosphatase"),
        "GGT": ("ggt", "gamaglutamiltransferaz"),
        "TBIL": ("tbil", "tbili", "totalbilirubin", "bilirubintotal"),
        "GLU": ("glu", "glukoz", "glucose", "kansekeri"),
        "T4": ("t4", "tt4", "totalt4", "tiroksin"),
        "NA": ("na", "sodyum", "sodium"),
        "K": ("k", "potasyum", "potassium"),
        "CA": ("ca", "kalsiyum", "calcium"),
    }


# Her takma adın kendi standart adına eşlendiğini doğrular.
@pytest.mark.parametrize(
    ("alias", "canonical"),
    [
        pytest.param(alias, canonical, id=f"{canonical}-{alias}")
        for canonical, aliases in TEST_NAME_ALIASES.items()
        for alias in aliases
    ],
)
def test_every_alias_maps_to_its_canonical(alias: str, canonical: str) -> None:
    assert SYNONYMS[alias] == canonical
    assert canonical_test_name(alias) == canonical
    assert canonical_test_name(alias.upper()) == canonical


# Takma adların çakışmadığını ve hepsinin normalize edilmiş olduğunu doğrular.
def test_aliases_do_not_collide_and_are_normalized() -> None:
    aliases = [alias for group in TEST_NAME_ALIASES.values() for alias in group]

    assert len(aliases) == len(set(aliases)) == len(SYNONYMS)
    assert all(normalize_test_name(alias) == alias for alias in aliases)
    assert set(SYNONYMS.values()) == set(TEST_NAME_ALIASES)


# Her standart adın normalize edilmiş halinin de kendi takma adı olduğunu doğrular.
@pytest.mark.parametrize("canonical", list(TEST_NAME_ALIASES))
def test_canonical_names_map_to_themselves(canonical: str) -> None:
    assert canonical_test_name(canonical) == canonical


# Eş anlamlılar tablolarının değiştirilemez olduğunu doğrular.
def test_tables_are_read_only() -> None:
    assert isinstance(SYNONYMS, MappingProxyType)
    assert isinstance(TEST_NAME_ALIASES, MappingProxyType)
    with pytest.raises(TypeError):
        SYNONYMS["yeni"] = "ALT"


# Türkçe ve İngilizce yazılmış test adlarının standart ada çevrildiğini doğrular.
@pytest.mark.parametrize(
    ("name", "expected"),
    [
        pytest.param("Lökosit", "WBC", id="lokosit"),
        pytest.param("Nötrofil", "NEU", id="notrofil"),
        pytest.param("Kan Üre Azotu", "BUN", id="kan-ure-azotu"),
        pytest.param("Üre", "UREA", id="ure"),
        pytest.param("Kreatinin", "CREA", id="kreatinin"),
        pytest.param("Alkalen Fosfataz", "ALP", id="alkalen-fosfataz"),
        pytest.param("Gama Glutamil Transferaz", "GGT", id="ggt"),
        pytest.param("Bilirubin (Total)", "TBIL", id="bilirubin-total"),
        pytest.param("Kan Şekeri", "GLU", id="kan-sekeri"),
        pytest.param("Total T4", "T4", id="total-t4"),
        pytest.param("K+", "K", id="potasyum-isareti"),
        pytest.param("Kalsiyum", "CA", id="kalsiyum"),
        pytest.param("Lökosit (WBC)", None, id="iki-ad-birlikte"),
        pytest.param("Kolesterol", None, id="bilinmeyen"),
        pytest.param("", None, id="bos"),
    ],
)
def test_canonical_test_name(name: str, expected: str | None) -> None:
    assert canonical_test_name(name) == expected


# Kalıpların sözleşmedeki sıra, kimlik, başlık ve kaynakla tanımlandığını doğrular.
def test_patterns_are_defined_in_contract_order() -> None:
    assert tuple(pattern.id for pattern in PATTERNS) == PATTERN_IDS
    assert tuple(pattern.title for pattern in PATTERNS) == PATTERN_TITLES
    assert all(isinstance(pattern, Pattern) for pattern in PATTERNS)
    assert all(pattern.source == GUIDE_SOURCE_PENDING for pattern in PATTERNS)
    assert GUIDE_SOURCE_PENDING == "Taslak; veteriner hekim onayı bekliyor"


# Rehber metinlerinde test adı T4 dışında rakam bulunmadığını doğrular.
@pytest.mark.parametrize("pattern", [pytest.param(p, id=p.id) for p in PATTERNS])
def test_guides_contain_no_digits(pattern: Pattern) -> None:
    assert pattern.guide.strip() == pattern.guide
    assert not any(character.isdigit() for character in pattern.guide.replace("T4", ""))


# Bulgu kurallarının yalnızca ilgili test ve durumda tetiklendiğini doğrular.
@pytest.mark.parametrize(
    ("pattern_id", "canonicals", "statuses"),
    [pytest.param(*rule, id=rule[0]) for rule in FINDING_RULES],
)
@pytest.mark.parametrize("species", ["CAT", "DOG", ""])
def test_finding_rules_trigger_only_on_matching_status(
    pattern_id: str,
    canonicals: tuple[str, ...],
    statuses: tuple[str, ...],
    species: str,
) -> None:
    for canonical in canonicals:
        for status in ALL_STATUSES:
            expected = (pattern_id,) if status in statuses else ()

            ids = triggered_ids(analysis_of(finding(canonical, status)), species)

            assert ids == expected, (canonical, status)


# Bilinmeyen test adlarının hiçbir kalıbı tetiklemediğini doğrular.
@pytest.mark.parametrize("status", ALL_STATUSES)
def test_unknown_test_names_trigger_nothing(status: str) -> None:
    assert triggered_ids(analysis_of(finding("Kolesterol", status))) == ()


# Tiroid kalıbının kedide yüksek, köpekte düşük T4 ile tetiklendiğini doğrular.
@pytest.mark.parametrize(
    ("species", "status", "triggered"),
    [
        pytest.param("CAT", STATUS_HIGH, True, id="kedi-yuksek"),
        pytest.param("CAT", STATUS_LOW, False, id="kedi-dusuk"),
        pytest.param("CAT", STATUS_NORMAL, False, id="kedi-normal"),
        pytest.param("CAT", STATUS_UNKNOWN, False, id="kedi-bilinmiyor"),
        pytest.param("DOG", STATUS_LOW, True, id="kopek-dusuk"),
        pytest.param("DOG", STATUS_HIGH, False, id="kopek-yuksek"),
        pytest.param("DOG", STATUS_NORMAL, False, id="kopek-normal"),
        pytest.param("DOG", STATUS_UNKNOWN, False, id="kopek-bilinmiyor"),
        pytest.param("", STATUS_HIGH, False, id="tur-yok-yuksek"),
        pytest.param("", STATUS_LOW, False, id="tur-yok-dusuk"),
        pytest.param("RABBIT", STATUS_HIGH, False, id="tavsan-yuksek"),
        pytest.param("RABBIT", STATUS_LOW, False, id="tavsan-dusuk"),
        pytest.param("cat", STATUS_HIGH, False, id="kucuk-harf-tur"),
    ],
)
def test_thyroid_depends_on_species(species: str, status: str, triggered: bool) -> None:
    ids = triggered_ids(analysis_of(finding("Total T4", status)), species)

    assert ids == (("thyroid",) if triggered else ())


# Aşı kalıbının yalnızca hatırlatma varken tetiklendiğini doğrular.
@pytest.mark.parametrize(
    ("reminders", "expected"),
    [
        pytest.param((REMINDER,), ("vaccination",), id="hatirlatma-var"),
        pytest.param((), (), id="hatirlatma-yok"),
    ],
)
def test_vaccination_requires_reminders(
    reminders: tuple[VaccinationReminderInfo, ...], expected: tuple[str, ...]
) -> None:
    assert triggered_ids(analysis_of(reminders=reminders), "") == expected


# Kalıpların bulgu sırasından bağımsız, tanım sırasıyla ve tekrarsız geldiğini doğrular.
def test_patterns_keep_definition_order_without_duplicates() -> None:
    analysis = analysis_of(
        finding("Kalsiyum", STATUS_HIGH),
        finding("T4", STATUS_LOW),
        finding("Kreatinin", STATUS_HIGH),
        finding("Hematokrit", STATUS_LOW),
        finding("HGB", STATUS_LOW),
        finding("SDMA", STATUS_HIGH),
        finding("Glukoz", STATUS_NORMAL),
        reminders=(REMINDER, REMINDER),
    )

    triggered = triggered_patterns(analysis, "DOG")

    assert tuple(pattern.id for pattern in triggered) == (
        "anemia",
        "kidney",
        "thyroid",
        "electrolyte",
        "vaccination",
    )
    assert all(pattern in PATTERNS for pattern in triggered)


# Her şey tetiklendiğinde bütün kalıpların tanım sırasıyla döndüğünü doğrular.
def test_all_patterns_can_trigger_together() -> None:
    analysis = analysis_of(
        finding("PCV", STATUS_LOW),
        finding("BUN", STATUS_HIGH),
        finding("ALT", STATUS_HIGH),
        finding("Glucose", STATUS_LOW),
        finding("WBC", STATUS_HIGH),
        finding("TT4", STATUS_HIGH),
        finding("Sodyum", STATUS_LOW),
        reminders=(REMINDER,),
    )

    assert triggered_patterns(analysis, "CAT") == PATTERNS


# Bulgu ve hatırlatma yoksa hiçbir kalıbın tetiklenmediğini doğrular.
def test_empty_analysis_triggers_nothing() -> None:
    assert triggered_patterns(analysis_of(), "CAT") == ()
