import { isPlainMultilineText, isPlainText } from '@libs/dto';
import { medicalRecord } from '@libs/proto';
import { maxLength, minLength } from 'class-validator';

export const HEALTH_ASSESSMENT_SUMMARY_MAX_LENGTH = 2000;
export const HEALTH_ASSESSMENT_TEXT_MAX_LENGTH = 500;
export const HEALTH_ASSESSMENT_QUESTION_MAX_LENGTH = 300;
export const HEALTH_ASSESSMENT_NAME_MAX_LENGTH = 128;
export const HEALTH_ASSESSMENT_FINDINGS_MAX = 50;
export const HEALTH_ASSESSMENT_CONDITIONS_MAX = 10;
export const HEALTH_ASSESSMENT_EVIDENCE_MAX = 10;
export const HEALTH_ASSESSMENT_RECOMMENDATIONS_MAX = 15;
export const HEALTH_ASSESSMENT_REMINDERS_MAX = 20;
export const HEALTH_ASSESSMENT_QUESTIONS_MAX = 10;

// AI servisindeki FORBIDDEN_CONTENT kuralının aynısı (sözleşme 7A.7).
export const DOSE_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}_.,])\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|g|ml|iu|ünite|tablet|kapsül|damla)(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:mg|ml)\s*\/\s*kg(?![\p{L}\p{N}_])/iu,
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface HealthAssessmentContent {
  summary: string;
  riskLevel: medicalRecord.HealthRiskLevel;
  payload: Record<string, unknown>;
  confidence: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasDose = (value: string): boolean =>
  DOSE_PATTERNS.some((pattern) => pattern.test(value));

const isLineWithin = (value: string, min: number, max: number): boolean =>
  minLength(value.trim(), min) &&
  maxLength(value.trim(), max) &&
  isPlainText(value);

const isTextWithin = (value: string, max: number): boolean =>
  minLength(value.trim(), 1) &&
  maxLength(value.trim(), max) &&
  isPlainMultilineText(value) &&
  !hasDose(value);

const isKnownEnum = (value: number, unspecified: number): boolean =>
  value !== unspecified && value !== -1;

const isDateOnly = (value: string): boolean =>
  DATE_ONLY.test(value) && !Number.isNaN(Date.parse(value));

const hasArraysOrMissing = (
  raw: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  keys.every((key) => raw[key] === undefined || Array.isArray(raw[key]));

const isUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

function isValidFinding(
  finding: medicalRecord.HealthFinding,
  testNames: ReadonlySet<string>,
): boolean {
  return (
    testNames.has(finding.testName) &&
    finding.trend !== -1 &&
    isTextWithin(finding.interpretation, HEALTH_ASSESSMENT_TEXT_MAX_LENGTH)
  );
}

function isValidCondition(
  condition: medicalRecord.PossibleCondition,
  testNames: ReadonlySet<string>,
): boolean {
  return (
    isLineWithin(condition.name, 1, HEALTH_ASSESSMENT_NAME_MAX_LENGTH) &&
    !hasDose(condition.name) &&
    isKnownEnum(
      condition.likelihood,
      medicalRecord.ConditionLikelihood.CONDITION_LIKELIHOOD_UNSPECIFIED,
    ) &&
    condition.evidence.length >= 1 &&
    condition.evidence.length <= HEALTH_ASSESSMENT_EVIDENCE_MAX &&
    isUnique(condition.evidence) &&
    condition.evidence.every((name) => testNames.has(name)) &&
    isTextWithin(condition.explanation, HEALTH_ASSESSMENT_TEXT_MAX_LENGTH)
  );
}

function isValidRecommendation(
  recommendation: medicalRecord.HealthRecommendation,
): boolean {
  return (
    isKnownEnum(
      recommendation.category,
      medicalRecord.RecommendationCategory.RECOMMENDATION_CATEGORY_UNSPECIFIED,
    ) && isTextWithin(recommendation.text, HEALTH_ASSESSMENT_TEXT_MAX_LENGTH)
  );
}

function isValidReminder(reminder: medicalRecord.VaccinationReminder): boolean {
  return (
    isLineWithin(reminder.vaccineName, 1, HEALTH_ASSESSMENT_NAME_MAX_LENGTH) &&
    isDateOnly(reminder.nextDueAt) &&
    isKnownEnum(
      reminder.status,
      medicalRecord.VaccinationDueStatus.VACCINATION_DUE_STATUS_UNSPECIFIED,
    )
  );
}

export function validateHealthAssessment(
  raw: unknown,
  confidence: number,
  testNames: ReadonlySet<string>,
): HealthAssessmentContent | null {
  if (!Number.isFinite(confidence) || !isPlainObject(raw)) return null;
  if (
    !hasArraysOrMissing(raw, [
      'findings',
      'possibleConditions',
      'recommendations',
      'vaccinationReminders',
      'questionsForVet',
    ])
  ) {
    return null;
  }

  const assessment = medicalRecord.HealthAssessment.fromJSON(raw);
  const summary = assessment.summary.trim();
  const findingNames = assessment.findings.map((item) => item.testName);

  const valid =
    isTextWithin(summary, HEALTH_ASSESSMENT_SUMMARY_MAX_LENGTH) &&
    isKnownEnum(
      assessment.riskLevel,
      medicalRecord.HealthRiskLevel.HEALTH_RISK_LEVEL_UNSPECIFIED,
    ) &&
    assessment.findings.length <= HEALTH_ASSESSMENT_FINDINGS_MAX &&
    isUnique(findingNames) &&
    assessment.findings.every((item) => isValidFinding(item, testNames)) &&
    assessment.possibleConditions.length <= HEALTH_ASSESSMENT_CONDITIONS_MAX &&
    assessment.possibleConditions.every((item) =>
      isValidCondition(item, testNames),
    ) &&
    assessment.recommendations.length <=
      HEALTH_ASSESSMENT_RECOMMENDATIONS_MAX &&
    assessment.recommendations.every(isValidRecommendation) &&
    assessment.vaccinationReminders.length <= HEALTH_ASSESSMENT_REMINDERS_MAX &&
    assessment.vaccinationReminders.every(isValidReminder) &&
    assessment.questionsForVet.length <= HEALTH_ASSESSMENT_QUESTIONS_MAX &&
    assessment.questionsForVet.every((question) =>
      isTextWithin(question, HEALTH_ASSESSMENT_QUESTION_MAX_LENGTH),
    );
  if (!valid) return null;

  const payload = medicalRecord.HealthAssessment.toJSON(assessment) as Record<
    string,
    unknown
  >;
  delete payload['summary'];
  delete payload['riskLevel'];

  return {
    summary,
    riskLevel: assessment.riskLevel,
    payload,
    confidence: Math.min(Math.max(confidence, 0), 1),
  };
}
