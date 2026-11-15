import argparse
import json
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from app.assessments.pipeline import ASSESSMENT_MAX_OUTPUT_TOKENS
from app.llm.prompts import ASSESS_PROMPT_VERSION
from evaluation.metrics import OK, RISK_ORDER, RunResult, Summary, summarize
from evaluation.scenarios import AS_OF, SCENARIOS, Scenario

UNKNOWN = "—"
LIKELIHOOD_NAMES = {
    "CONDITION_LIKELIHOOD_LOW": "düşük",
    "CONDITION_LIKELIHOOD_MEDIUM": "orta",
    "CONDITION_LIKELIHOOD_HIGH": "yüksek",
}
TREND_NAMES = {
    "LAB_TREND_SINGLE": "tek ölçüm",
    "LAB_TREND_RISING": "artıyor",
    "LAB_TREND_FALLING": "azalıyor",
    "LAB_TREND_STABLE": "sabit",
}
CATEGORY_NAMES = {
    "RECOMMENDATION_NUTRITION": "Beslenme",
    "RECOMMENDATION_CARE": "Bakım",
    "RECOMMENDATION_FOLLOW_UP_TEST": "Kontrol testi",
    "RECOMMENDATION_VET_VISIT": "Veteriner",
    "RECOMMENDATION_VACCINATION": "Aşı",
}


# JSONL dosyasındaki çalıştırma sonuçlarını okur.
def load_results(path: Path) -> list[RunResult]:
    results: list[RunResult] = []
    with path.open(encoding="utf-8") as lines:
        for line in lines:
            if not line.strip():
                continue
            row = json.loads(line)
            for key in (
                "findings",
                "missing_findings",
                "missing_reminders",
                "leaked_markers",
                "issue_codes",
            ):
                row[key] = tuple(row[key])
            results.append(RunResult(**row))
    return results


# Sayıyı oran ve yüzde olarak yazar, payda sıfırsa tire verir.
def ratio(part: int, whole: int) -> str:
    if whole == 0:
        return UNKNOWN
    return f"{part}/{whole} (%{round(part / whole * 100)})"


# Ondalıklı değeri verilen basamakla yazar, değer yoksa tire verir.
def number(value: float | None, digits: int = 0) -> str:
    return UNKNOWN if value is None else f"{value:.{digits}f}"


# Risk sayımlarını seviye sırasıyla kısa bir metne çevirir.
def risk_counts(summary: Summary) -> str:
    parts = [
        f"{level} {summary.risk_counts[level]}"
        for level in RISK_ORDER
        if level in summary.risk_counts
    ]
    return ", ".join(parts) or UNKNOWN


# Markdown tablosunu başlık ve satırlardan üretir.
def table(headers: Sequence[str], rows: Iterable[Sequence[str]]) -> list[str]:
    return [
        f"| {' | '.join(headers)} |",
        f"|{'|'.join('---' for _ in headers)}|",
        *(f"| {' | '.join(row)} |" for row in rows),
    ]


# Bütün çalıştırmaların özet ölçütlerini tablo satırlarına çevirir.
def overall_rows(summary: Summary) -> list[tuple[str, str]]:
    return [
        ("Çalıştırma", str(summary.runs)),
        ("Doğrulanmış sonuç üreten", ratio(summary.completed, summary.runs)),
        ("İki denemede de geçersiz çıktı", str(summary.invalid)),
        ("AI API'ye 5 denemede ulaşılamayan", str(summary.unavailable)),
        ("Risk seviyesi tam eşleşme", ratio(summary.exact, summary.risk_scored)),
        ("Risk seviyesi ±1 içinde", ratio(summary.within_one, summary.risk_scored)),
        (
            "Riskin beklenenden düşük çıkması",
            ratio(summary.under_triage, summary.risk_scored),
        ),
        (
            "Riskin beklenenden yüksek çıkması",
            ratio(summary.over_triage, summary.risk_scored),
        ),
        ("Son çıktıda doz ifadesi", str(summary.dose_texts)),
        ("Enjeksiyon işaretinin çıktıya sızması", str(summary.leaked_markers)),
        ("Beklenen bulgusu eksik sonuç", str(summary.missing_findings)),
        ("Beklenen aşı hatırlatması eksik sonuç", str(summary.missing_reminders)),
        ("İlk yanıtta doğrulamadan geçen", ratio(summary.first_pass, summary.runs)),
        ("Zaman aşımı nedeniyle yeniden denenen", str(summary.retried_runs)),
        ("Ortalama güven skoru", number(summary.mean_confidence, 2)),
        ("Medyan süre (sn)", number(summary.median_seconds)),
        ("En uzun süre (sn)", number(summary.max_seconds)),
        ("Ortalama girdi tokeni", number(summary.mean_prompt_tokens)),
        ("Ortalama çıktı tokeni", number(summary.mean_completion_tokens)),
    ]


# Bir senaryonun özetini senaryo tablosu satırına çevirir.
def scenario_row(scenario: Scenario, summary: Summary) -> list[str]:
    return [
        scenario.title,
        scenario.expected_risk or UNKNOWN,
        risk_counts(summary),
        ratio(summary.exact, summary.risk_scored),
        ratio(summary.within_one, summary.risk_scored),
        str(summary.under_triage),
        str(summary.missing_findings + summary.missing_reminders),
        number(summary.mean_confidence, 2),
        number(summary.median_seconds),
    ]


# Sonuç metnindeki satır sonlarını tablo ve liste için tek satıra indirir.
def inline(text: str) -> str:
    return " ".join(text.split())


# Bir senaryonun ilk başarılı çıktısını okunur Markdown satırlarına çevirir.
def sample_lines(scenario: Scenario, run: RunResult) -> list[str]:
    output: dict[str, Any] = run.output
    lines = [
        f"### {scenario.title}",
        "",
        f"Risk: {run.risk_level}. Güven: {number(run.confidence, 2)}.",
        "",
        f"**Özet:** {inline(output.get('summary', ''))}",
    ]
    findings = [
        f"- {item['testName']} "
        f"({TREND_NAMES.get(item.get('trend', ''), 'belirlenemedi')}): "
        f"{inline(item['interpretation'])}"
        for item in output.get("findings", [])
    ]
    conditions = [
        f"- {item['name']} "
        f"(olasılık: {LIKELIHOOD_NAMES[item['likelihood']]}): "
        f"{inline(item['explanation'])}"
        for item in output.get("possibleConditions", [])
    ]
    recommendations = [
        f"- {CATEGORY_NAMES[item['category']]}: {inline(item['text'])}"
        for item in output.get("recommendations", [])
    ]
    questions = [f"- {inline(item)}" for item in output.get("questionsForVet", [])]
    for title, items in (
        ("Bulgular", findings),
        ("Olası durumlar", conditions),
        ("Öneriler", recommendations),
        ("Veterinere sorular", questions),
    ):
        if items:
            lines.extend(["", f"**{title}:**", "", *items])
    lines.append("")
    return lines


# Çalıştırma sonuçlarından rapor metnini üretir.
def render(results: Sequence[RunResult], model: str) -> str:
    overall = summarize(results)
    by_scenario = {
        scenario.id: [run for run in results if run.scenario_id == scenario.id]
        for scenario in SCENARIOS
    }
    lines = [
        "# Sağlık Değerlendirmesi: Model Değerlendirmesi",
        "",
        f"`{model}` modeli ve `{ASSESS_PROMPT_VERSION}` talimatı, "
        f"{len(SCENARIOS)} sentetik senaryoda "
        f"{overall.runs // len(SCENARIOS)}'er kez çalıştırıldı "
        f"(toplam {overall.runs}). {overall.exact}/{overall.risk_scored} "
        "sonuçta risk seviyesi beklenenle birebir eşleşti; "
        f"son çıktılarda {overall.dose_texts} doz ifadesi bulundu.",
        "",
        f"Değerlendirme tarihi {AS_OF}. Veriler sentetiktir, gerçek hayvan ve "
        "kişi bilgisi içermez.",
        "",
        "## Yöntem",
        "",
        "- Her çalıştırma üretimdeki akışın aynısından geçer: girdi denetimi, "
        "kural tabanlı ön analiz, rehber seçimi, model çağrısı, doğrulama ve "
        "en fazla bir düzeltme turu.",
        "- Geçici hatada üretimdeki gibi 30 sn arayla en fazla 5 deneme yapılır; "
        "süreler bekleme dahil, kullanıcının göreceği toplam süredir.",
        "- Risk seviyesi tam eşleşme ve ±1 seviye tolerans olarak ayrı ölçülür. "
        "Riskin beklenenden düşük çıkması ayrıca sayılır, çünkü en önemli "
        "güvenlik hatası budur.",
        "- Ölçüm `apps/ai-service/evaluation` altındaki araçla tekrarlanabilir.",
        "",
        "## Genel sonuçlar",
        "",
        *table(("Ölçüt", "Sonuç"), overall_rows(overall)),
        "",
        "## Senaryo sonuçları",
        "",
        *table(
            (
                "Senaryo",
                "Beklenen",
                "Üretilen risk",
                "Tam",
                "±1",
                "Eksik uyarı",
                "Eksik bulgu",
                "Güven",
                "Medyan sn",
            ),
            (
                scenario_row(scenario, summarize(by_scenario[scenario.id]))
                for scenario in SCENARIOS
            ),
        ),
        "",
        "## Ölçümün bulduğu hata",
        "",
        "İlk ölçümde (`assess-v1`) anemik köpek senaryosu 5 çalıştırmanın 5'inde de "
        "sonuç üretemedi, kullanıcı bekleyişi 200–840 sn'yi buldu. Model, olası "
        "durumda `evidence` listesini yazdıktan sonra zorunlu `explanation` alanını "
        "atlayıp nesneyi kapatmak istiyor, şema buna izin vermediği için çıktı "
        "sınırına kadar boşluk üretiyordu. Şemada `explanation` alanı öne alındı ve "
        f"değerlendirme çıktısına {ASSESSMENT_MAX_OUTPUT_TOKENS} token sınırı "
        "kondu. Bu rapordaki sonuçlar düzeltme sonrası `assess-v2` ölçümüdür.",
        "",
        "## Örnek çıktılar",
        "",
        "Her senaryonun ilk başarılı çıktısı, model metni değiştirilmeden verilmiştir.",
        "",
    ]
    for scenario in SCENARIOS:
        sample = next(
            (run for run in by_scenario[scenario.id] if run.outcome == OK), None
        )
        if sample is not None:
            lines.extend(sample_lines(scenario, sample))
    return "\n".join(lines).rstrip() + "\n"


# Komut satırı seçeneklerini okuyup raporu yazar.
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", required=True)
    arguments = parser.parse_args()
    report = render(load_results(arguments.input), arguments.model)
    with arguments.output.open("w", encoding="utf-8", newline="\n") as target:
        target.write(report)


if __name__ == "__main__":
    main()
