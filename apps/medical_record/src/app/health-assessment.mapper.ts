import { medicalRecord } from '@libs/proto';
import {
  HealthAssessment,
  HealthAssessmentStatus,
  HealthRiskLevel,
} from '../generated/prisma/client';

export const HEALTH_RISK_LEVEL_TO_DB: Partial<
  Record<medicalRecord.HealthRiskLevel, HealthRiskLevel>
> = {
  [medicalRecord.HealthRiskLevel.HEALTH_RISK_LOW]: HealthRiskLevel.LOW,
  [medicalRecord.HealthRiskLevel.HEALTH_RISK_MODERATE]:
    HealthRiskLevel.MODERATE,
  [medicalRecord.HealthRiskLevel.HEALTH_RISK_HIGH]: HealthRiskLevel.HIGH,
  [medicalRecord.HealthRiskLevel.HEALTH_RISK_URGENT]: HealthRiskLevel.URGENT,
};

const HEALTH_RISK_LEVEL_TO_PROTO: Record<
  HealthRiskLevel,
  medicalRecord.HealthRiskLevel
> = {
  [HealthRiskLevel.LOW]: medicalRecord.HealthRiskLevel.HEALTH_RISK_LOW,
  [HealthRiskLevel.MODERATE]:
    medicalRecord.HealthRiskLevel.HEALTH_RISK_MODERATE,
  [HealthRiskLevel.HIGH]: medicalRecord.HealthRiskLevel.HEALTH_RISK_HIGH,
  [HealthRiskLevel.URGENT]: medicalRecord.HealthRiskLevel.HEALTH_RISK_URGENT,
};

const HEALTH_ASSESSMENT_STATUS_TO_PROTO: Record<
  HealthAssessmentStatus,
  medicalRecord.HealthAssessmentStatus
> = {
  [HealthAssessmentStatus.PENDING]:
    medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_PENDING,
  [HealthAssessmentStatus.READY]:
    medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_READY,
  [HealthAssessmentStatus.FAILED]:
    medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_FAILED,
};

export function toProtoHealthAssessment(
  row: HealthAssessment,
  currentInputHash: string,
): medicalRecord.HealthAssessmentResponse {
  const base = {
    status: HEALTH_ASSESSMENT_STATUS_TO_PROTO[row.status],
    requestedAt: row.requestedAt.toISOString(),
    isStale: row.inputHash !== currentInputHash,
  };

  if (row.status !== HealthAssessmentStatus.READY || !row.riskLevel) {
    return { ...base, assessment: undefined, confidence: 0, generatedAt: '' };
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    ...base,
    assessment: medicalRecord.HealthAssessment.fromJSON({
      ...payload,
      summary: row.summary ?? '',
      riskLevel: medicalRecord.healthRiskLevelToJSON(
        HEALTH_RISK_LEVEL_TO_PROTO[row.riskLevel],
      ),
    }),
    confidence: row.confidence ?? 0,
    generatedAt: row.generatedAt ? row.generatedAt.toISOString() : '',
  };
}
