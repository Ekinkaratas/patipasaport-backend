import argparse
import asyncio
import dataclasses
import json
import logging
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast

from google.protobuf import json_format

from app.assessments.analyze import Analysis, analyze
from app.assessments.pipeline import AssessmentPipeline
from app.assessments.validate import (
    AssessmentInvalid,
    has_dose_expression,
    validate_assessment,
)
from app.config import load_settings
from app.errors import PermanentError, TransientError
from app.generated import events_pb2, medical_record_pb2
from app.llm.client import (
    MAX_OUTPUT_TOKENS,
    ChatTurn,
    IncompleteOutputError,
    LlmClient,
    LlmReply,
    create_llm_client,
)
from app.messaging.cloudevents import (
    DATASCHEMAS,
    HEALTH_ASSESSMENT_GENERATED,
    HEALTH_ASSESSMENT_REQUESTED,
    OutgoingEvent,
    parse_event,
)
from app.messaging.publisher import Publisher
from app.messaging.topology import MAX_ATTEMPTS, RETRY_DELAY_MS
from app.validation import parse_date, trim
from evaluation.metrics import INVALID, OK, RISK_ORDER, UNAVAILABLE, RunResult
from evaluation.scenarios import AS_OF, REQUEST_ID, SCENARIOS, Scenario

DEFAULT_RUNS = 5
INCOMPLETE = "INCOMPLETE"
QUIET_LOGGERS = ("httpx", "httpcore", "LlmClient", "AssessmentPipeline")
RISK_NAMES: Mapping[int, str] = {
    medical_record_pb2.HEALTH_RISK_LOW: RISK_ORDER[0],
    medical_record_pb2.HEALTH_RISK_MODERATE: RISK_ORDER[1],
    medical_record_pb2.HEALTH_RISK_HIGH: RISK_ORDER[2],
    medical_record_pb2.HEALTH_RISK_URGENT: RISK_ORDER[3],
}


class CollectingPublisher:
    # Yayınlanan olayları RabbitMQ'ya gitmeden bellekte toplayan yayıncıyı kurar.
    def __init__(self) -> None:
        self.events: list[OutgoingEvent] = []

    # Olayı kaydeder.
    async def publish(self, event: OutgoingEvent) -> None:
        self.events.append(event)


class RecordingLlm:
    # Gerçek istemciyi, test adlarını ve kritik bilgisini saklar, sayaçları sıfırlar.
    def __init__(
        self, inner: LlmClient, test_names: Sequence[str], has_critical: bool
    ) -> None:
        self._inner = inner
        self._test_names = test_names
        self._has_critical = has_critical
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.issue_codes: list[str] = []

    # İsteği gerçek istemciye iletir, kullanım ve doğrulama sonucunu kaydeder.
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_text: str,
        image_data_urls: Sequence[str] = (),
        schema_name: str,
        schema: Mapping[str, object],
        follow_up: Sequence[ChatTurn] = (),
        max_output_tokens: int = MAX_OUTPUT_TOKENS,
    ) -> LlmReply:
        self.calls += 1
        try:
            reply = await self._inner.complete_json(
                system_prompt=system_prompt,
                user_text=user_text,
                image_data_urls=image_data_urls,
                schema_name=schema_name,
                schema=schema,
                follow_up=follow_up,
                max_output_tokens=max_output_tokens,
            )
        except IncompleteOutputError:
            self.issue_codes.append(INCOMPLETE)
            raise
        self.prompt_tokens += reply.prompt_tokens or 0
        self.completion_tokens += reply.completion_tokens or 0
        try:
            validate_assessment(
                reply.content, self._test_names, has_critical=self._has_critical
            )
        except AssessmentInvalid as error:
            self.issue_codes.extend(issue.code for issue in error.issues)
        return reply


# Senaryonun verisini ayrıştırılmış bir değerlendirme isteği olayına çevirir.
def request_event(scenario: Scenario) -> Any:
    envelope = {
        "specversion": "1.0",
        "id": "3e5a7c9d-1f2b-4c3d-a5e7-9b1d3f5a7c2e",
        "source": "/patipasaport/medical-record",
        "type": HEALTH_ASSESSMENT_REQUESTED,
        "subject": REQUEST_ID,
        "time": f"{AS_OF}T09:00:00.000Z",
        "datacontenttype": "application/json",
        "dataschema": DATASCHEMAS[HEALTH_ASSESSMENT_REQUESTED],
        "data": scenario.data,
    }
    return parse_event(
        json.dumps(envelope).encode("utf-8"), HEALTH_ASSESSMENT_REQUESTED
    )


# Senaryonun kurallı ön analizini gerçek akışla aynı eşikle hesaplar.
def scenario_analysis(scenario: Scenario, percent: float) -> Analysis:
    event = request_event(scenario)
    as_of = parse_date(event.data.as_of)
    if as_of is None:
        raise ValueError("Senaryo tarihi geçersiz")
    return analyze(event.data, as_of, critical_deviation_percent=percent)


# Değerlendirmedeki model metinlerinin hepsini sırayla toplar.
def assessment_texts(assessment: medical_record_pb2.HealthAssessment) -> list[str]:
    return [
        assessment.summary,
        *(finding.interpretation for finding in assessment.findings),
        *(condition.name for condition in assessment.possible_conditions),
        *(condition.explanation for condition in assessment.possible_conditions),
        *(item.text for item in assessment.recommendations),
        *assessment.questions_for_vet,
    ]


# Başarılı bir değerlendirmeyi senaryonun beklentileriyle karşılaştırıp sonuca çevirir.
def completed_result(
    scenario: Scenario,
    run: int,
    generated: events_pb2.HealthAssessmentGenerated,
    recorder: RecordingLlm,
    attempts: int,
    seconds: float,
) -> RunResult:
    assessment = generated.assessment
    findings = tuple(finding.test_name for finding in assessment.findings)
    reminders = {item.vaccine_name for item in assessment.vaccination_reminders}
    texts = assessment_texts(assessment)
    return RunResult(
        scenario_id=scenario.id,
        run=run,
        outcome=OK,
        risk_level=RISK_NAMES[assessment.risk_level],
        expected_risk=scenario.expected_risk,
        confidence=generated.confidence,
        findings=findings,
        conditions=len(assessment.possible_conditions),
        missing_findings=tuple(
            name for name in scenario.expected_findings if name not in findings
        ),
        missing_reminders=tuple(
            name for name in scenario.expected_reminders if name not in reminders
        ),
        leaked_markers=tuple(
            marker
            for marker in scenario.forbidden_markers
            if any(marker in text for text in texts)
        ),
        dose_texts=sum(has_dose_expression(text) for text in texts),
        model_calls=recorder.calls,
        first_pass=recorder.calls == 1 and not recorder.issue_codes,
        issue_codes=tuple(recorder.issue_codes),
        attempts=attempts,
        seconds=seconds,
        prompt_tokens=recorder.prompt_tokens,
        completion_tokens=recorder.completion_tokens,
        output=json_format.MessageToDict(assessment),
    )


# Senaryoyu üretimdeki gibi en fazla 5 denemeyle ve 30 sn arayla bir kez çalıştırır.
async def run_scenario(
    scenario: Scenario, run: int, llm: LlmClient, model: str, percent: float
) -> RunResult:
    analysis = scenario_analysis(scenario, percent)
    recorder = RecordingLlm(
        llm,
        tuple(trim(finding.test_name) for finding in analysis.findings),
        analysis.has_critical,
    )
    pipeline = AssessmentPipeline(cast(LlmClient, recorder), model, percent)
    started = time.monotonic()
    for attempt in range(1, MAX_ATTEMPTS + 1):
        publisher = CollectingPublisher()
        try:
            await pipeline.handle(request_event(scenario), cast(Publisher, publisher))
        except TransientError:
            if attempt < MAX_ATTEMPTS:
                await asyncio.sleep(RETRY_DELAY_MS / 1000)
            continue
        except PermanentError:
            return RunResult(
                scenario_id=scenario.id,
                run=run,
                outcome=INVALID,
                expected_risk=scenario.expected_risk,
                model_calls=recorder.calls,
                issue_codes=tuple(recorder.issue_codes),
                attempts=attempt,
                seconds=time.monotonic() - started,
                prompt_tokens=recorder.prompt_tokens,
                completion_tokens=recorder.completion_tokens,
            )
        generated = parse_event(
            publisher.events[0].body, HEALTH_ASSESSMENT_GENERATED
        ).data
        return completed_result(
            scenario,
            run,
            cast(events_pb2.HealthAssessmentGenerated, generated),
            recorder,
            attempt,
            time.monotonic() - started,
        )
    return RunResult(
        scenario_id=scenario.id,
        run=run,
        outcome=UNAVAILABLE,
        expected_risk=scenario.expected_risk,
        model_calls=recorder.calls,
        attempts=MAX_ATTEMPTS,
        seconds=time.monotonic() - started,
    )


# Tamamlanmış çalıştırmaları sonuç dosyasından okuyup senaryo ve sıraya göre verir.
def completed_runs(path: Path) -> set[tuple[str, int]]:
    if not path.exists():
        return set()
    with path.open(encoding="utf-8") as lines:
        rows = [json.loads(line) for line in lines if line.strip()]
    return {(row["scenario_id"], row["run"]) for row in rows}


# Bütün senaryoları sırayla çalıştırıp her sonucu JSONL dosyasına ekler.
async def evaluate(path: Path, runs: int) -> None:
    settings = load_settings()
    finished = completed_runs(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    client = create_llm_client(settings)
    try:
        for run in range(1, runs + 1):
            for scenario in SCENARIOS:
                if (scenario.id, run) in finished:
                    continue
                result = await run_scenario(
                    scenario,
                    run,
                    client,
                    settings.ai_model,
                    settings.assessment_critical_deviation_percent,
                )
                with path.open("a", encoding="utf-8", newline="\n") as output:
                    output.write(
                        json.dumps(dataclasses.asdict(result), ensure_ascii=False)
                        + "\n"
                    )
                print(
                    f"{scenario.id} #{run}: {result.outcome} "
                    f"risk={result.risk_level} deneme={result.attempts} "
                    f"sure={result.seconds:.0f}s",
                    flush=True,
                )
    finally:
        await client.aclose()


# Komut satırı seçeneklerini okuyup değerlendirmeyi başlatır.
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    arguments = parser.parse_args()
    logging.disable(logging.WARNING)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.ERROR)
    asyncio.run(evaluate(arguments.output, arguments.runs))


if __name__ == "__main__":
    main()
