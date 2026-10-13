import { RecordContentDto } from '@libs/dto';
import { medicalRecord } from '@libs/proto';
import {
  Document,
  DocumentStatus,
  DraftReviewStatus,
  LabResultFlag,
  Prisma,
  RecordType,
} from '../generated/prisma/client';

export const RECORD_INCLUDE = {
  vaccination: true,
  prescription: true,
  labResults: { orderBy: [{ testName: 'asc' }, { id: 'asc' }] },
  attachments: {
    include: { document: true },
    orderBy: [{ document: { createdAt: 'asc' } }, { documentId: 'asc' }],
  },
} satisfies Prisma.MedicalRecordInclude;

export type RecordWithDetails = Prisma.MedicalRecordGetPayload<{
  include: typeof RECORD_INCLUDE;
}>;

export const DOCUMENT_INCLUDE = {
  draftReview: { select: { id: true } },
} satisfies Prisma.DocumentInclude;

export type DocumentWithDraft = Prisma.DocumentGetPayload<{
  include: typeof DOCUMENT_INCLUDE;
}>;

export const DRAFT_INCLUDE = {
  document: true,
} satisfies Prisma.DraftReviewInclude;

export type DraftWithDocument = Prisma.DraftReviewGetPayload<{
  include: typeof DRAFT_INCLUDE;
}>;

export const VACCINATION_INCLUDE = {
  record: { select: { petId: true, clinicId: true } },
} satisfies Prisma.VaccinationInclude;

export type VaccinationWithRecord = Prisma.VaccinationGetPayload<{
  include: typeof VACCINATION_INCLUDE;
}>;

export const PRESCRIPTION_INCLUDE = {
  record: { select: { petId: true, clinicId: true } },
} satisfies Prisma.PrescriptionInclude;

export type PrescriptionWithRecord = Prisma.PrescriptionGetPayload<{
  include: typeof PRESCRIPTION_INCLUDE;
}>;

export const LAB_RESULT_INCLUDE = {
  record: { select: { petId: true, clinicId: true } },
} satisfies Prisma.LabResultInclude;

export type LabResultWithRecord = Prisma.LabResultGetPayload<{
  include: typeof LAB_RESULT_INCLUDE;
}>;

export type RecordContentData = Pick<
  Prisma.MedicalRecordUncheckedCreateInput,
  | 'type'
  | 'title'
  | 'notes'
  | 'recordedAt'
  | 'vaccination'
  | 'prescription'
  | 'labResults'
>;

const RECORD_TYPE_TO_PROTO: Record<RecordType, medicalRecord.RecordType> = {
  [RecordType.EXAMINATION]: medicalRecord.RecordType.EXAMINATION,
  [RecordType.VACCINATION]: medicalRecord.RecordType.VACCINATION,
  [RecordType.PRESCRIPTION]: medicalRecord.RecordType.PRESCRIPTION,
  [RecordType.LAB_RESULT]: medicalRecord.RecordType.LAB_RESULT,
  [RecordType.SURGERY]: medicalRecord.RecordType.SURGERY,
};

export const RECORD_TYPE_TO_DB: Partial<
  Record<medicalRecord.RecordType, RecordType>
> = {
  [medicalRecord.RecordType.EXAMINATION]: RecordType.EXAMINATION,
  [medicalRecord.RecordType.VACCINATION]: RecordType.VACCINATION,
  [medicalRecord.RecordType.PRESCRIPTION]: RecordType.PRESCRIPTION,
  [medicalRecord.RecordType.LAB_RESULT]: RecordType.LAB_RESULT,
  [medicalRecord.RecordType.SURGERY]: RecordType.SURGERY,
};

const DOCUMENT_STATUS_TO_PROTO: Record<
  DocumentStatus,
  medicalRecord.DocumentStatus
> = {
  [DocumentStatus.QUEUED]: medicalRecord.DocumentStatus.QUEUED,
  [DocumentStatus.PROCESSING]: medicalRecord.DocumentStatus.PROCESSING,
  [DocumentStatus.DRAFT_READY]: medicalRecord.DocumentStatus.DRAFT_READY,
  [DocumentStatus.FAILED]: medicalRecord.DocumentStatus.FAILED,
};

const DRAFT_STATUS_TO_PROTO: Record<
  DraftReviewStatus,
  medicalRecord.DraftReviewStatus
> = {
  [DraftReviewStatus.PENDING]: medicalRecord.DraftReviewStatus.PENDING,
  [DraftReviewStatus.APPROVED]: medicalRecord.DraftReviewStatus.APPROVED,
  [DraftReviewStatus.REJECTED]: medicalRecord.DraftReviewStatus.REJECTED,
};

export const DRAFT_STATUS_TO_DB: Partial<
  Record<medicalRecord.DraftReviewStatus, DraftReviewStatus>
> = {
  [medicalRecord.DraftReviewStatus.PENDING]: DraftReviewStatus.PENDING,
  [medicalRecord.DraftReviewStatus.APPROVED]: DraftReviewStatus.APPROVED,
  [medicalRecord.DraftReviewStatus.REJECTED]: DraftReviewStatus.REJECTED,
};

const LAB_RESULT_FLAG_TO_PROTO: Record<
  LabResultFlag,
  medicalRecord.LabResultFlag
> = {
  [LabResultFlag.NORMAL]: medicalRecord.LabResultFlag.NORMAL,
  [LabResultFlag.LOW]: medicalRecord.LabResultFlag.LOW,
  [LabResultFlag.HIGH]: medicalRecord.LabResultFlag.HIGH,
};

const LAB_RESULT_FLAG_TO_DB: Partial<
  Record<medicalRecord.LabResultFlag, LabResultFlag>
> = {
  [medicalRecord.LabResultFlag.NORMAL]: LabResultFlag.NORMAL,
  [medicalRecord.LabResultFlag.LOW]: LabResultFlag.LOW,
  [medicalRecord.LabResultFlag.HIGH]: LabResultFlag.HIGH,
};

export const toDateOnly = (value: Date): string =>
  value.toISOString().slice(0, 10);

export const fromDateOnly = (value: string): Date => new Date(value);

export function toFileReference(row: Document): medicalRecord.FileReference {
  return {
    documentId: row.id,
    storagePath: row.storagePath,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
  };
}

export function toProtoDocument(
  row: DocumentWithDraft,
): medicalRecord.Document {
  return {
    id: row.id,
    petId: row.petId,
    clinicId: row.clinicId,
    storagePath: row.storagePath,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    note: row.note ?? '',
    status: DOCUMENT_STATUS_TO_PROTO[row.status],
    failureReason: row.failureReason ?? '',
    draftReviewId: row.draftReview?.id ?? '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProtoRecord(
  row: RecordWithDetails,
): medicalRecord.MedicalRecord {
  const [firstLabResult] = row.labResults;

  return {
    id: row.id,
    petId: row.petId,
    clinicId: row.clinicId,
    type: RECORD_TYPE_TO_PROTO[row.type],
    title: row.title,
    notes: row.notes ?? '',
    recordedAt: toDateOnly(row.recordedAt),
    attachments: row.attachments.map((attachment) =>
      toFileReference(attachment.document),
    ),
    sourceDraftReviewId: row.sourceDraftReviewId ?? '',
    createdAt: row.createdAt.toISOString(),
    vaccination: row.vaccination
      ? {
          vaccineName: row.vaccination.vaccineName,
          batchNumber: row.vaccination.batchNumber ?? '',
          administeredAt: toDateOnly(row.vaccination.administeredAt),
          nextDueAt: row.vaccination.nextDueAt
            ? toDateOnly(row.vaccination.nextDueAt)
            : '',
        }
      : undefined,
    prescription: row.prescription
      ? {
          medicationName: row.prescription.medicationName,
          dosage: row.prescription.dosage,
          frequency: row.prescription.frequency,
          durationDays: row.prescription.durationDays,
          instructions: row.prescription.instructions ?? '',
          prescribedAt: toDateOnly(row.prescription.prescribedAt),
        }
      : undefined,
    labResult: firstLabResult
      ? {
          items: row.labResults.map((item) => ({
            testName: item.testName,
            value: item.value,
            unit: item.unit ?? '',
            referenceRange: item.referenceRange ?? '',
            flag: item.flag
              ? LAB_RESULT_FLAG_TO_PROTO[item.flag]
              : medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
          })),
          sampledAt: toDateOnly(firstLabResult.sampledAt),
        }
      : undefined,
  };
}

export function toProtoVaccination(
  row: VaccinationWithRecord,
): medicalRecord.Vaccination {
  return {
    id: row.id,
    recordId: row.recordId,
    petId: row.record.petId,
    clinicId: row.record.clinicId,
    vaccineName: row.vaccineName,
    batchNumber: row.batchNumber ?? '',
    administeredAt: toDateOnly(row.administeredAt),
    nextDueAt: row.nextDueAt ? toDateOnly(row.nextDueAt) : '',
  };
}

export function toProtoPrescription(
  row: PrescriptionWithRecord,
): medicalRecord.Prescription {
  return {
    id: row.id,
    recordId: row.recordId,
    petId: row.record.petId,
    clinicId: row.record.clinicId,
    medicationName: row.medicationName,
    dosage: row.dosage,
    frequency: row.frequency,
    durationDays: row.durationDays,
    instructions: row.instructions ?? '',
    prescribedAt: toDateOnly(row.prescribedAt),
  };
}

export function toProtoLabResult(
  row: LabResultWithRecord,
): medicalRecord.LabResult {
  return {
    id: row.id,
    recordId: row.recordId,
    petId: row.record.petId,
    clinicId: row.record.clinicId,
    testName: row.testName,
    value: row.value,
    unit: row.unit ?? '',
    referenceRange: row.referenceRange ?? '',
    flag: row.flag
      ? LAB_RESULT_FLAG_TO_PROTO[row.flag]
      : medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
    sampledAt: toDateOnly(row.sampledAt),
  };
}

export function toProtoDraft(
  row: DraftWithDocument,
): medicalRecord.DraftReview {
  return {
    id: row.id,
    petId: row.petId,
    clinicId: row.clinicId,
    sourceFiles: [toFileReference(row.document)],
    status: DRAFT_STATUS_TO_PROTO[row.status],
    reviewNote: row.reviewNote ?? '',
    createdRecordId: row.createdRecordId ?? '',
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : '',
    reviewedByClinicId: row.reviewedByClinicId ?? '',
    documentId: row.documentId,
    proposal: row.proposedPayload as unknown as medicalRecord.RecordContent,
    approvedContent: row.approvedPayload
      ? (row.approvedPayload as unknown as medicalRecord.RecordContent)
      : undefined,
    modelVersion: row.modelVersion,
    confidence: row.confidence,
  };
}

export function toRecordContentData(
  content: RecordContentDto,
): RecordContentData {
  const recordType = RECORD_TYPE_TO_DB[content.type];
  if (!recordType) {
    throw new Error(
      `toRecordContentData: geçersiz kayıt türü (${content.type})`,
    );
  }

  const { vaccination, prescription, labResult } = content;

  return {
    type: recordType,
    title: content.title,
    notes: content.notes ?? null,
    recordedAt: fromDateOnly(content.recordedAt),
    ...(vaccination
      ? {
          vaccination: {
            create: {
              vaccineName: vaccination.vaccineName,
              batchNumber: vaccination.batchNumber ?? null,
              administeredAt: fromDateOnly(vaccination.administeredAt),
              nextDueAt: vaccination.nextDueAt
                ? fromDateOnly(vaccination.nextDueAt)
                : null,
            },
          },
        }
      : {}),
    ...(prescription
      ? {
          prescription: {
            create: {
              medicationName: prescription.medicationName,
              dosage: prescription.dosage,
              frequency: prescription.frequency,
              durationDays: prescription.durationDays,
              instructions: prescription.instructions ?? null,
              prescribedAt: fromDateOnly(prescription.prescribedAt),
            },
          },
        }
      : {}),
    ...(labResult
      ? {
          labResults: {
            create: labResult.items.map((item) => ({
              testName: item.testName,
              value: item.value,
              unit: item.unit ?? null,
              referenceRange: item.referenceRange ?? null,
              flag: LAB_RESULT_FLAG_TO_DB[item.flag] ?? null,
              sampledAt: fromDateOnly(labResult.sampledAt),
            })),
          },
        }
      : {}),
  };
}
