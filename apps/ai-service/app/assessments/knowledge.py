import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from app.assessments.analyze import STATUS_HIGH, STATUS_LOW, Analysis

GUIDE_SOURCE_PENDING = "Taslak; veteriner hekim onayı bekliyor"

ANEMIA = "anemia"
KIDNEY = "kidney"
LIVER = "liver"
GLUCOSE = "glucose"
INFLAMMATION = "inflammation"
THYROID = "thyroid"
ELECTROLYTE = "electrolyte"
VACCINATION = "vaccination"

_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]")


@dataclass(frozen=True)
class Pattern:
    id: str
    title: str
    guide: str
    source: str


@dataclass(frozen=True)
class _FindingRule:
    canonicals: frozenset[str]
    statuses: frozenset[str]
    species_statuses: Mapping[str, frozenset[str]]

    # Bulgunun standart adı ve durumunun türe göre bu kurala uyup uymadığını söyler.
    def matches(self, canonical: str | None, status: str, species: str) -> bool:
        allowed = self.species_statuses.get(species, self.statuses)
        return canonical in self.canonicals and status in allowed


TEST_NAME_ALIASES: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
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
)

SYNONYMS: Mapping[str, str] = MappingProxyType(
    {
        alias: canonical
        for canonical, aliases in TEST_NAME_ALIASES.items()
        for alias in aliases
    }
)

PATTERNS: tuple[Pattern, ...] = (
    Pattern(
        id=ANEMIA,
        title="Anemi bulgusu",
        guide=(
            "HCT, HGB ya da RBC referans aralığının altındaysa bu durum anemiyle "
            "(kansızlık) ilişkili olabilir. Olası nedenler arasında kan kaybı (iç ya "
            "da dış kanama, parazitler), kırmızı kan hücrelerinin yıkımı ve kemik "
            "iliğinde yapımın azalması (ör. kronik hastalık, beslenme eksikliği) "
            "sayılabilir. Nedenin ayrımı için retikülosit sayımı, kan yayması ve "
            "tekrar hemogram gibi testlerin yapılıp yapılmayacağı veteriner hekimle "
            "konuşulabilir. Dengeli ve kaliteli protein içeren beslenme, düzenli "
            "parazit kontrolü ve dinlenme destekleyici olabilir; demir ya da başka "
            "bir takviyenin gerekip gerekmediğine veteriner hekim karar verir. "
            "Solukluk, halsizlik ya da hızlı solunum varsa hekime başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=KIDNEY,
        title="Böbrek değerleri",
        guide=(
            "BUN (ya da üre), kreatinin ya da SDMA referans aralığının üstündeyse "
            "böbreklerin atıkları süzme işleviyle ilgili bir durum olabilir. Bu "
            "yükseklik sıvı kaybı (dehidrasyon), yüksek proteinli bir öğün ya da "
            "böbrek hastalığı gibi farklı nedenlerle görülebilir; tek bir ölçümle "
            "ayrım yapılamaz. İdrar tahlili (idrar yoğunluğu dahil), tansiyon "
            "ölçümü ve bir süre sonra tekrar ölçüm yapılıp yapılmayacağı veteriner "
            "hekimle konuşulabilir. Hayvanın her zaman taze suya erişmesi önemlidir; "
            "böbrek dostu bir diyetin gerekip gerekmediğine veteriner hekim karar "
            "verir. Çok su içme, sık idrara çıkma, iştahsızlık ya da kusma varsa "
            "hekime başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=LIVER,
        title="Karaciğer değerleri",
        guide=(
            "ALT, ALP, GGT ya da total bilirubin referans aralığının üstündeyse "
            "karaciğer ya da safra yollarıyla ilgili bir durum olabilir. Bu "
            "değerler bazı ilaçlar, hormonal durumlar, beslenme, yaş ya da karaciğer "
            "hastalıkları gibi farklı nedenlerle yükselebilir. Kullanılan ilaç ve "
            "takviyelerin hekimle gözden geçirilmesi, safra asitleri testi ya da "
            "karın ultrasonu gibi ek incelemelerin gerekip gerekmediği "
            "konuşulabilir. Yağdan zengin artık yemeklerden kaçınmak ve hekimin "
            "önereceği beslenme düzenini izlemek destekleyici olabilir. Gözlerde ya "
            "da ciltte sararma, iştahsızlık veya kusma varsa hekime "
            "başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=GLUCOSE,
        title="Kan şekeri",
        guide=(
            "Glukoz (kan şekeri) referans aralığının dışındaysa enerji "
            "metabolizmasıyla ilgili bir durum olabilir. Yükseklik kedilerde "
            "muayene sırasındaki stresle geçici olarak görülebilir; kalıcı "
            "yükseklik diyabet gibi durumlarla ilişkili olabilir. Düşüklük uzun "
            "açlık, yavrularda ya da küçük ırklarda yetersiz beslenme veya bazı "
            "hastalıklarla görülebilir. Fruktozamin testi, idrarda şeker bakılması "
            "ya da tekrar ölçüm yapılıp yapılmayacağı veteriner hekimle "
            "konuşulabilir. Düzenli öğün saatleri, ideal kilonun korunması ve su "
            "tüketimi ile idrar miktarının takibi faydalı olabilir. Çok su içme, "
            "sık idrara çıkma, kilo kaybı, titreme ya da bayılma varsa hekime "
            "başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=INFLAMMATION,
        title="Bağışıklık hücreleri",
        guide=(
            "Lökosit (WBC) ya da nötrofil sayısı referans aralığının dışındaysa "
            "bağışıklık sistemiyle ilgili bir durum olabilir. Yükseklik enfeksiyon, "
            "iltihap, stres ya da bazı ilaçlarla; düşüklük bazı viral "
            "enfeksiyonlar, kemik iliği sorunları ya da ağır enfeksiyonlarla "
            "ilişkili olabilir. Kan yayması ve bir süre sonra tekrar hemogram "
            "yapılıp yapılmayacağı veteriner hekimle konuşulabilir. Ateş, iştah, su "
            "tüketimi ve genel hareketlilik takip edilebilir; hayvanın dinlenmesi "
            "ve aşılarının güncel tutulması destekleyicidir. Ateş, halsizlik, "
            "iştahsızlık ya da ishal varsa hekime başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=THYROID,
        title="Tiroid değeri",
        guide=(
            "Kedide T4 yüksekliği tiroid bezinin fazla çalışmasıyla (hipertiroidi), "
            "köpekte T4 düşüklüğü tiroid bezinin az çalışmasıyla (hipotiroidi) "
            "ilişkili olabilir. T4 değeri başka hastalıklardan ve bazı ilaçlardan "
            "da etkilenebileceği için tek ölçümle sonuca varılmaz; serbest T4 ya da "
            "TSH gibi ek testler veteriner hekimle konuşulabilir. Kilo, iştah, tüy "
            "ve cilt durumu ile hareketlilikteki değişikliklerin not edilmesi "
            "hekime yardımcı olur. Hızlı kilo kaybı, aşırı iştah, huzursuzluk ya da "
            "belirgin halsizlik varsa hekime başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=ELECTROLYTE,
        title="Elektrolitler",
        guide=(
            "Sodyum, potasyum ya da kalsiyum referans aralığının dışındaysa vücudun "
            "sıvı ve mineral dengesiyle ilgili bir durum olabilir. Bu değerler "
            "kusma, ishal, sıvı kaybı, böbrek ya da hormon sorunları, bazı ilaçlar "
            "ve beslenme gibi farklı nedenlerle değişebilir. Potasyum ve "
            "kalsiyumdaki belirgin sapmalar kalp ve kas işlevini etkileyebileceği "
            "için önemsenmelidir. Tekrar ölçüm ve gerekirse ek incelemeler "
            "veteriner hekimle konuşulabilir; hayvanın taze suya erişmesi ile "
            "kusma, ishal ve su tüketiminin takibi önemlidir. Kas titremesi, "
            "belirgin halsizlik, nöbet ya da kalp ritminde düzensizlik fark "
            "edilirse hemen hekime başvurulmalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
    Pattern(
        id=VACCINATION,
        title="Aşı takvimi",
        guide=(
            "Bir aşının bir sonraki tarihi geçmişse ya da yakında doluyorsa, "
            "hayvanın korunmasının sürmesi için veteriner hekimle bir randevu "
            "planlanması önerilir. Gecikmiş aşının nasıl tamamlanacağına, tekrar "
            "başlatma gerekip gerekmediği dahil, veteriner hekim karar verir. Aşı "
            "öncesinde hayvanın genel sağlık durumunun hekime anlatılması "
            "faydalıdır."
        ),
        source=GUIDE_SOURCE_PENDING,
    ),
)

_LOW_OR_HIGH = frozenset({STATUS_LOW, STATUS_HIGH})
_NO_SPECIES_RULES: Mapping[str, frozenset[str]] = MappingProxyType({})
_FINDING_RULES: Mapping[str, _FindingRule] = MappingProxyType(
    {
        ANEMIA: _FindingRule(
            frozenset({"HCT", "HGB", "RBC"}),
            frozenset({STATUS_LOW}),
            _NO_SPECIES_RULES,
        ),
        KIDNEY: _FindingRule(
            frozenset({"BUN", "UREA", "CREA", "SDMA"}),
            frozenset({STATUS_HIGH}),
            _NO_SPECIES_RULES,
        ),
        LIVER: _FindingRule(
            frozenset({"ALT", "ALP", "GGT", "TBIL"}),
            frozenset({STATUS_HIGH}),
            _NO_SPECIES_RULES,
        ),
        GLUCOSE: _FindingRule(frozenset({"GLU"}), _LOW_OR_HIGH, _NO_SPECIES_RULES),
        INFLAMMATION: _FindingRule(
            frozenset({"WBC", "NEU"}), _LOW_OR_HIGH, _NO_SPECIES_RULES
        ),
        THYROID: _FindingRule(
            frozenset({"T4"}),
            frozenset(),
            MappingProxyType(
                {"CAT": frozenset({STATUS_HIGH}), "DOG": frozenset({STATUS_LOW})}
            ),
        ),
        ELECTROLYTE: _FindingRule(
            frozenset({"NA", "K", "CA"}), _LOW_OR_HIGH, _NO_SPECIES_RULES
        ),
    }
)


# Test adını aksansız, küçük harfli ve yalnızca harf ile rakamdan oluşan biçime getirir.
def normalize_test_name(name: str) -> str:
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(
        character for character in decomposed if not unicodedata.combining(character)
    )
    return _NON_ALPHANUMERIC.sub("", stripped.casefold().replace("ı", "i"))


# Test adının eş anlamlılar tablosundaki standart adını verir, bilinmiyorsa None döner.
def canonical_test_name(name: str) -> str | None:
    return SYNONYMS.get(normalize_test_name(name))


# Bulgulara ve aşı hatırlatmalarına göre tetiklenen rehber kalıplarını sırasıyla verir.
def triggered_patterns(analysis: Analysis, species: str) -> tuple[Pattern, ...]:
    findings = tuple(
        (canonical_test_name(finding.test_name), finding.status)
        for finding in analysis.findings
    )
    triggered: list[Pattern] = []
    for pattern in PATTERNS:
        if pattern.id == VACCINATION:
            matched = bool(analysis.reminders)
        else:
            rule = _FINDING_RULES[pattern.id]
            matched = any(
                rule.matches(canonical, status, species)
                for canonical, status in findings
            )
        if matched:
            triggered.append(pattern)
    return tuple(triggered)
