jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { medicalRecord, pets } from '@libs/proto';
import { LabResultFlag, RecordType } from '../generated/prisma/client';
import {
  buildHealthAssessmentSnapshot,
  EMPTY_HEALTH_ASSESSMENT_PET,
  hashHealthAssessmentRecords,
  toHealthAssessmentPetContext,
  toHealthAssessmentRequestedData,
  truncateNotes,
  windowStart,
} from './health-assessment.snapshot';
import { PrismaService } from './prisma/prisma.service';

const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const REQUEST_ID = 'c4a1e9d2-3b5f-4a7c-8e6d-1f2a3b4c5d6e';
const AS_OF = '2026-11-01';
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

// ---Amaç: veritabanındaki bir tahlil kalemini üretmek ---
const labRow = (
  testName: string,
  sampledAt: string,
  value: string,
  over: Record<string, unknown> = {},
) => ({
  id: `${testName}-${sampledAt}`,
  recordId: `kayit-${sampledAt}`,
  testName,
  value,
  unit: '%',
  referenceRange: '37-55',
  flag: null,
  sampledAt: day(sampledAt),
  ...over,
});

// ---Amaç: snapshot sorgularını taklit eden sahte Prisma üretmek ---
const fakePrisma = (rows: {
  labResults?: unknown[];
  vaccinations?: unknown[];
  prescriptions?: unknown[];
  notes?: unknown[];
}) => ({
  labResult: { findMany: jest.fn().mockResolvedValue(rows.labResults ?? []) },
  vaccination: {
    findMany: jest.fn().mockResolvedValue(rows.vaccinations ?? []),
  },
  prescription: {
    findMany: jest.fn().mockResolvedValue(rows.prescriptions ?? []),
  },
  medicalRecord: { findMany: jest.fn().mockResolvedValue(rows.notes ?? []) },
});

const build = (prisma: ReturnType<typeof fakePrisma>) =>
  buildHealthAssessmentSnapshot(
    prisma as unknown as PrismaService,
    PET_ID,
    AS_OF,
  );

describe('health-assessment.snapshot', () => {
  it('pencere başlangıcı asOf tarihinden 24 ay öncedir', () =>
    expect(windowStart(AS_OF)).toEqual(day('2024-11-01')));

  it('notlar kırpılır ve 1000 karakterde kesilir', () => {
    expect(truncateNotes(null)).toBe('');
    expect(truncateNotes('  not  ')).toBe('not');
    expect(truncateNotes('ğ'.repeat(1200))).toBe('ğ'.repeat(1000));
  });

  it('pets yanıtı hayvan bilgilerine çevrilir, yoksa boş bilgiler döner', () => {
    expect(toHealthAssessmentPetContext(undefined)).toBe(
      EMPTY_HEALTH_ASSESSMENT_PET,
    );
    expect(
      toHealthAssessmentPetContext({
        species: 'DOG',
        breed: 'GOLDEN_RETRIEVER',
        sex: pets.PetSex.FEMALE,
        isNeutered: true,
        birthDate: '2023-04-10',
        isBirthDateEstimated: false,
      } as pets.Pet),
    ).toEqual({
      species: 'DOG',
      breed: 'GOLDEN_RETRIEVER',
      sex: 'FEMALE',
      isNeutered: true,
      birthDate: '2023-04-10',
      isBirthDateEstimated: false,
    });
    expect(
      toHealthAssessmentPetContext({
        species: 'CAT',
        breed: '',
        sex: pets.PetSex.PET_SEX_UNSPECIFIED,
        isNeutered: false,
        birthDate: '',
        isBirthDateEstimated: false,
      } as pets.Pet),
    ).toMatchObject({ sex: '', birthDate: '' });
  });

  it('kayıt yoksa snapshot boştur', async () => {
    const snapshot = await build(fakePrisma({}));
    expect(snapshot.isEmpty).toBe(true);
    expect(snapshot.recordIds).toEqual([]);
  });

  it('tahliller teste göre gruplanır, en yeni 6 ölçüm eskiden yeniye sıralanır', async () => {
    const prisma = fakePrisma({
      labResults: [
        ...[
          '2025-01-01',
          '2025-02-01',
          '2025-03-01',
          '2025-04-01',
          '2025-05-01',
          '2025-06-01',
          '2025-07-01',
        ].map((date, index) => labRow('HCT ', date, String(40 - index))),
        labRow('HGB', '2025-06-15', '14', {
          flag: LabResultFlag.NORMAL,
          unit: null,
          referenceRange: null,
        }),
      ],
    });

    const snapshot = await build(prisma);

    expect(prisma.labResult.findMany).toHaveBeenCalledWith({
      where: {
        record: { petId: PET_ID },
        sampledAt: { gte: day('2024-11-01') },
      },
      orderBy: [{ sampledAt: 'asc' }, { id: 'asc' }],
    });
    expect(snapshot.records.labSeries.map((s) => s.testName)).toEqual([
      'HCT',
      'HGB',
    ]);
    const [hct, hgb] = snapshot.records.labSeries;
    expect(hct.measurements.map((m) => m.sampledAt)).toEqual([
      '2025-02-01',
      '2025-03-01',
      '2025-04-01',
      '2025-05-01',
      '2025-06-01',
      '2025-07-01',
    ]);
    expect(hct.measurements[0].flag).toBe(
      medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
    );
    expect(hgb.measurements).toEqual([
      {
        sampledAt: '2025-06-15',
        value: '14',
        unit: '',
        referenceRange: '',
        flag: medicalRecord.LabResultFlag.NORMAL,
      },
    ]);
    expect(snapshot.recordIds).not.toContain('kayit-2025-01-01');
    expect(snapshot.isEmpty).toBe(false);
  });

  it('en fazla 60 seri gönderilir, en son ölçülenler önce gelir', async () => {
    const prisma = fakePrisma({
      labResults: Array.from({ length: 61 }, (_, index) =>
        labRow(
          `T${String(index).padStart(2, '0')}`,
          `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
          '1',
        ),
      ),
    });
    const snapshot = await build(prisma);
    expect(snapshot.records.labSeries).toHaveLength(60);
  });

  it('her aşı adının yalnızca en son dozu alınır, pencere uygulanmaz', async () => {
    const prisma = fakePrisma({
      vaccinations: [
        {
          recordId: 'a2',
          vaccineName: 'Kuduz ',
          administeredAt: day('2025-10-05'),
          nextDueAt: day('2026-10-05'),
        },
        {
          recordId: 'a1',
          vaccineName: 'kuduz',
          administeredAt: day('2024-10-05'),
          nextDueAt: day('2025-10-05'),
        },
        {
          recordId: 'b1',
          vaccineName: 'Karma',
          administeredAt: day('2021-03-01'),
          nextDueAt: null,
        },
      ],
    });

    const snapshot = await build(prisma);

    expect(prisma.vaccination.findMany).toHaveBeenCalledWith({
      where: { record: { petId: PET_ID } },
      orderBy: [{ administeredAt: 'desc' }, { id: 'asc' }],
    });
    expect(snapshot.records.vaccinations).toEqual([
      {
        vaccineName: 'Kuduz',
        batchNumber: '',
        administeredAt: '2025-10-05',
        nextDueAt: '2026-10-05',
      },
      {
        vaccineName: 'Karma',
        batchNumber: '',
        administeredAt: '2021-03-01',
        nextDueAt: '',
      },
    ]);
    expect(snapshot.recordIds).toEqual(['a2', 'b1']);
  });

  it('reçeteler ve klinik notlar pencereyle ve en fazla 20 kayıtla alınır', async () => {
    const prisma = fakePrisma({
      prescriptions: [
        {
          recordId: 'r1',
          medicationName: ' İlaç ',
          dosage: '1 tablet',
          frequency: 'günde 2',
          durationDays: 7,
          instructions: null,
          prescribedAt: day('2026-09-01'),
        },
      ],
      notes: [
        {
          id: 'n1',
          type: RecordType.EXAMINATION,
          title: 'Genel muayene',
          notes: 'Halsizlik.',
          recordedAt: day('2026-10-28'),
        },
        {
          id: 'n2',
          type: RecordType.SURGERY,
          title: 'Kısırlaştırma',
          notes: null,
          recordedAt: day('2025-01-10'),
        },
      ],
    });

    const snapshot = await build(prisma);

    expect(prisma.prescription.findMany).toHaveBeenCalledWith({
      where: {
        record: { petId: PET_ID },
        prescribedAt: { gte: day('2024-11-01') },
      },
      orderBy: [{ prescribedAt: 'desc' }, { id: 'asc' }],
      take: 20,
    });
    expect(prisma.medicalRecord.findMany).toHaveBeenCalledWith({
      where: {
        petId: PET_ID,
        type: { in: [RecordType.EXAMINATION, RecordType.SURGERY] },
        recordedAt: { gte: day('2024-11-01') },
      },
      orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: 20,
    });
    expect(snapshot.records.prescriptions).toEqual([
      {
        medicationName: 'İlaç',
        dosage: '1 tablet',
        frequency: 'günde 2',
        durationDays: 7,
        instructions: '',
        prescribedAt: '2026-09-01',
      },
    ]);
    expect(snapshot.records.clinicalNotes).toEqual([
      {
        type: medicalRecord.RecordType.EXAMINATION,
        title: 'Genel muayene',
        notes: 'Halsizlik.',
        recordedAt: '2026-10-28',
      },
      {
        type: medicalRecord.RecordType.SURGERY,
        title: 'Kısırlaştırma',
        notes: '',
        recordedAt: '2025-01-10',
      },
    ]);
    expect(snapshot.recordIds).toEqual(['n1', 'n2', 'r1']);
  });

  it('hash yalnızca kayıtlara bağlıdır ve değişince değişir', async () => {
    const first = await build(
      fakePrisma({ labResults: [labRow('HCT', '2026-10-01', '35')] }),
    );
    const same = await build(
      fakePrisma({ labResults: [labRow('HCT', '2026-10-01', '35')] }),
    );
    const changed = await build(
      fakePrisma({ labResults: [labRow('HCT', '2026-10-01', '36')] }),
    );

    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(same.inputHash).toBe(first.inputHash);
    expect(changed.inputHash).not.toBe(first.inputHash);
    expect(hashHealthAssessmentRecords(first.records)).toBe(first.inputHash);
  });

  it('olay verisi proto JSON biçiminde ve enum adlarıyla üretilir', async () => {
    const snapshot = await build(
      fakePrisma({
        labResults: [
          labRow('HCT', '2026-10-01', '35', { flag: LabResultFlag.LOW }),
        ],
      }),
    );
    expect(
      toHealthAssessmentRequestedData(
        REQUEST_ID,
        AS_OF,
        { ...EMPTY_HEALTH_ASSESSMENT_PET, species: 'DOG', isNeutered: true },
        snapshot.records,
      ),
    ).toEqual({
      requestId: REQUEST_ID,
      asOf: AS_OF,
      species: 'DOG',
      isNeutered: true,
      labSeries: [
        {
          testName: 'HCT',
          measurements: [
            {
              sampledAt: '2026-10-01',
              value: '35',
              unit: '%',
              referenceRange: '37-55',
              flag: 'LOW',
            },
          ],
        },
      ],
    });
  });
});
