import { createHash } from 'crypto';
import { events, medicalRecord, pets } from '@libs/proto';
import { PrismaService } from './prisma/prisma.service';
import { RecordType } from '../generated/prisma/client';
import { fromDateOnly, toDateOnly } from './medical-record.mapper';

export const HEALTH_ASSESSMENT_WINDOW_MONTHS = 24;
export const HEALTH_ASSESSMENT_MAX_SERIES = 60;
export const HEALTH_ASSESSMENT_MAX_MEASUREMENTS = 6;
export const HEALTH_ASSESSMENT_MAX_ITEMS = 20;
export const HEALTH_ASSESSMENT_NOTES_MAX_LENGTH = 1000;

export interface HealthAssessmentPetContext {
  species: string;
  breed: string;
  sex: string;
  isNeutered: boolean;
  birthDate: string;
  isBirthDateEstimated: boolean;
}

export const EMPTY_HEALTH_ASSESSMENT_PET: HealthAssessmentPetContext = {
  species: '',
  breed: '',
  sex: '',
  isNeutered: false,
  birthDate: '',
  isBirthDateEstimated: false,
};

export type HealthAssessmentRecords = Pick<
  events.HealthAssessmentRequested,
  'labSeries' | 'vaccinations' | 'prescriptions' | 'clinicalNotes'
>;

export interface HealthAssessmentSnapshot {
  records: HealthAssessmentRecords;
  recordIds: string[];
  inputHash: string;
  isEmpty: boolean;
}

const PET_SEX_NAMES: Partial<Record<pets.PetSex, string>> = {
  [pets.PetSex.MALE]: 'MALE',
  [pets.PetSex.FEMALE]: 'FEMALE',
};

const CLINICAL_NOTE_TYPES: Partial<
  Record<RecordType, medicalRecord.RecordType>
> = {
  [RecordType.EXAMINATION]: medicalRecord.RecordType.EXAMINATION,
  [RecordType.SURGERY]: medicalRecord.RecordType.SURGERY,
};

const LAB_FLAG_TO_PROTO: Record<string, medicalRecord.LabResultFlag> = {
  NORMAL: medicalRecord.LabResultFlag.NORMAL,
  LOW: medicalRecord.LabResultFlag.LOW,
  HIGH: medicalRecord.LabResultFlag.HIGH,
};

export function windowStart(asOf: string): Date {
  const start = fromDateOnly(asOf);
  start.setUTCMonth(start.getUTCMonth() - HEALTH_ASSESSMENT_WINDOW_MONTHS);
  return start;
}

export function truncateNotes(notes: string | null): string {
  const characters = Array.from((notes ?? '').trim());
  return characters
    .slice(0, HEALTH_ASSESSMENT_NOTES_MAX_LENGTH)
    .join('')
    .trim();
}

export function toHealthAssessmentPetContext(
  pet: pets.Pet | undefined,
): HealthAssessmentPetContext {
  if (!pet) return EMPTY_HEALTH_ASSESSMENT_PET;

  const birthDate = new Date(pet.birthDate);
  return {
    species: pet.species,
    breed: pet.breed,
    sex: PET_SEX_NAMES[pet.sex] ?? '',
    isNeutered: pet.isNeutered,
    birthDate: Number.isNaN(birthDate.getTime()) ? '' : toDateOnly(birthDate),
    isBirthDateEstimated: pet.isBirthDateEstimated,
  };
}

export function hashHealthAssessmentRecords(
  records: HealthAssessmentRecords,
): string {
  const json = events.HealthAssessmentRequested.toJSON({
    requestId: '',
    asOf: '',
    ...EMPTY_HEALTH_ASSESSMENT_PET,
    ...records,
  });
  return createHash('sha256').update(JSON.stringify(json)).digest('hex');
}

async function loadLabSeries(
  prisma: PrismaService,
  petId: string,
  since: Date,
  recordIds: Set<string>,
): Promise<events.LabSeries[]> {
  const rows = await prisma.labResult.findMany({
    where: { record: { petId }, sampledAt: { gte: since } },
    orderBy: [{ sampledAt: 'asc' }, { id: 'asc' }],
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = row.testName.trim();
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }

  return [...groups.entries()]
    .map(([testName, group]) => ({
      testName,
      group: group.slice(-HEALTH_ASSESSMENT_MAX_MEASUREMENTS),
    }))
    .sort(
      (a, b) =>
        b.group[b.group.length - 1].sampledAt.getTime() -
          a.group[a.group.length - 1].sampledAt.getTime() ||
        a.testName.localeCompare(b.testName),
    )
    .slice(0, HEALTH_ASSESSMENT_MAX_SERIES)
    .map(({ testName, group }) => {
      group.forEach((row) => recordIds.add(row.recordId));
      return {
        testName,
        measurements: group.map((row) => ({
          sampledAt: toDateOnly(row.sampledAt),
          value: row.value.trim(),
          unit: (row.unit ?? '').trim(),
          referenceRange: (row.referenceRange ?? '').trim(),
          flag: row.flag
            ? LAB_FLAG_TO_PROTO[row.flag]
            : medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
        })),
      };
    });
}

async function loadVaccinations(
  prisma: PrismaService,
  petId: string,
  recordIds: Set<string>,
): Promise<medicalRecord.VaccinationDetails[]> {
  const rows = await prisma.vaccination.findMany({
    where: { record: { petId } },
    orderBy: [{ administeredAt: 'desc' }, { id: 'asc' }],
  });

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = row.vaccineName.trim().toLowerCase();
    if (!latest.has(key)) latest.set(key, row);
  }

  return [...latest.values()]
    .slice(0, HEALTH_ASSESSMENT_MAX_ITEMS)
    .map((row) => {
      recordIds.add(row.recordId);
      return {
        vaccineName: row.vaccineName.trim(),
        batchNumber: '',
        administeredAt: toDateOnly(row.administeredAt),
        nextDueAt: row.nextDueAt ? toDateOnly(row.nextDueAt) : '',
      };
    });
}

async function loadPrescriptions(
  prisma: PrismaService,
  petId: string,
  since: Date,
  recordIds: Set<string>,
): Promise<medicalRecord.PrescriptionDetails[]> {
  const rows = await prisma.prescription.findMany({
    where: { record: { petId }, prescribedAt: { gte: since } },
    orderBy: [{ prescribedAt: 'desc' }, { id: 'asc' }],
    take: HEALTH_ASSESSMENT_MAX_ITEMS,
  });

  return rows.map((row) => {
    recordIds.add(row.recordId);
    return {
      medicationName: row.medicationName.trim(),
      dosage: row.dosage.trim(),
      frequency: row.frequency.trim(),
      durationDays: row.durationDays,
      instructions: (row.instructions ?? '').trim(),
      prescribedAt: toDateOnly(row.prescribedAt),
    };
  });
}

async function loadClinicalNotes(
  prisma: PrismaService,
  petId: string,
  since: Date,
  recordIds: Set<string>,
): Promise<events.ClinicalNote[]> {
  const rows = await prisma.medicalRecord.findMany({
    where: {
      petId,
      type: { in: [RecordType.EXAMINATION, RecordType.SURGERY] },
      recordedAt: { gte: since },
    },
    orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: HEALTH_ASSESSMENT_MAX_ITEMS,
  });

  return rows.map((row) => {
    recordIds.add(row.id);
    return {
      type:
        CLINICAL_NOTE_TYPES[row.type] ??
        medicalRecord.RecordType.RECORD_TYPE_UNSPECIFIED,
      title: row.title.trim(),
      notes: truncateNotes(row.notes),
      recordedAt: toDateOnly(row.recordedAt),
    };
  });
}

export async function buildHealthAssessmentSnapshot(
  prisma: PrismaService,
  petId: string,
  asOf: string,
): Promise<HealthAssessmentSnapshot> {
  const since = windowStart(asOf);
  const recordIds = new Set<string>();

  const labSeries = await loadLabSeries(prisma, petId, since, recordIds);
  const vaccinations = await loadVaccinations(prisma, petId, recordIds);
  const prescriptions = await loadPrescriptions(
    prisma,
    petId,
    since,
    recordIds,
  );
  const clinicalNotes = await loadClinicalNotes(
    prisma,
    petId,
    since,
    recordIds,
  );

  const records = { labSeries, vaccinations, prescriptions, clinicalNotes };
  return {
    records,
    recordIds: [...recordIds].sort(),
    inputHash: hashHealthAssessmentRecords(records),
    isEmpty:
      labSeries.length === 0 &&
      vaccinations.length === 0 &&
      prescriptions.length === 0 &&
      clinicalNotes.length === 0,
  };
}

export function toHealthAssessmentRequestedData(
  requestId: string,
  asOf: string,
  pet: HealthAssessmentPetContext,
  records: HealthAssessmentRecords,
): unknown {
  return events.HealthAssessmentRequested.toJSON({
    requestId,
    asOf,
    ...pet,
    ...records,
  });
}
