import { medicalRecord, pets } from '@libs/proto';
import { RecordContentDto } from '@libs/dto';
import {
  Document,
  DocumentStatus,
  DraftReviewStatus,
  LabExplanationStatus,
  LabResultExplanation,
  LabResultFlag,
  RecordType,
} from '../generated/prisma/client';
import {
  DocumentWithDraft,
  DraftWithDocument,
  EMPTY_PET_CONTEXT,
  fromDateOnly,
  LabResultWithRecord,
  PrescriptionWithRecord,
  RecordWithDetails,
  toDateOnly,
  toFileReference,
  toLabExplanationPetContext,
  toLabExplanationRequestedData,
  toProtoDocument,
  toProtoDraft,
  toProtoLabExplanation,
  toProtoLabResult,
  toProtoPrescription,
  toProtoRecord,
  toProtoVaccination,
  toRecordContentData,
  VaccinationWithRecord,
} from './medical-record.mapper';

const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const CREATED = new Date('2026-10-13T08:30:00.000Z');

// ---Amaç: veritabanındaki belge satırını üretmek ---
const documentRow = (over: Partial<Document> = {}): Document => ({
  id: 'belge-1',
  petId: PET_ID,
  clinicId: CLINIC_ID,
  storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
  originalName: 'Kan Tahlili.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  note: null,
  status: DocumentStatus.QUEUED,
  failureReason: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
});

// ---Amaç: ayrıntıları ve ekleriyle birlikte kayıt satırını üretmek ---
const recordRow = (
  over: Partial<RecordWithDetails> = {},
): RecordWithDetails => ({
  id: 'kayit-1',
  petId: PET_ID,
  clinicId: CLINIC_ID,
  type: RecordType.EXAMINATION,
  title: 'Genel muayene',
  notes: null,
  recordedAt: new Date('2026-10-12T00:00:00.000Z'),
  sourceDocumentId: null,
  sourceDraftReviewId: null,
  createdAt: CREATED,
  vaccination: null,
  prescription: null,
  labResults: [],
  attachments: [],
  ...over,
});

const owner = { record: { petId: PET_ID, clinicId: CLINIC_ID } };

// ---Amaç: tarih ve dosya referansı dönüşümlerini doğrulamak ---
describe('tarih ve dosya referansı', () => {
  it('date kolonu YYYY-AA-GG olur, YYYY-AA-GG UTC gece yarısına çevrilir', () => {
    expect(toDateOnly(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-12');
    expect(fromDateOnly('2026-10-12').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });

  it('belge dosya referansına çevrilir, yükleme zamanı belgenin oluşturulma zamanıdır', () => {
    expect(toFileReference(documentRow())).toEqual({
      documentId: 'belge-1',
      storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
      originalName: 'Kan Tahlili.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      uploadedAt: '2026-10-13T08:30:00.000Z',
    });
  });
});

// ---Amaç: belge satırının boş alanları boş string, durumu sayısal enum olarak döndürdüğünü doğrulamak ---
describe('toProtoDocument', () => {
  it('taslağı olmayan QUEUED belge', () => {
    const row: DocumentWithDraft = { ...documentRow(), draftReview: null };
    expect(toProtoDocument(row)).toMatchObject({
      note: '',
      failureReason: '',
      draftReviewId: '',
      status: medicalRecord.DocumentStatus.QUEUED,
      createdAt: '2026-10-13T08:30:00.000Z',
    });
  });

  it.each([
    [DocumentStatus.PROCESSING, medicalRecord.DocumentStatus.PROCESSING],
    [DocumentStatus.DRAFT_READY, medicalRecord.DocumentStatus.DRAFT_READY],
    [DocumentStatus.FAILED, medicalRecord.DocumentStatus.FAILED],
  ])(
    '%s durumu eşlenir, taslak id ve hata nedeni taşınır',
    (status, expected) => {
      const row: DocumentWithDraft = {
        ...documentRow({ status, note: 'not', failureReason: 'UNREADABLE' }),
        draftReview: { id: 'taslak-1' },
      };
      expect(toProtoDocument(row)).toMatchObject({
        status: expected,
        note: 'not',
        failureReason: 'UNREADABLE',
        draftReviewId: 'taslak-1',
      });
    },
  );
});

// ---Amaç: kaydın türüne göre yalnızca ilgili ayrıntıyla ve ekleriyle döndüğünü doğrulamak ---
describe('toProtoRecord', () => {
  it('ayrıntısız muayene: ayrıntılar undefined, boş alanlar boş string', () => {
    expect(toProtoRecord(recordRow())).toEqual({
      id: 'kayit-1',
      petId: PET_ID,
      clinicId: CLINIC_ID,
      type: medicalRecord.RecordType.EXAMINATION,
      title: 'Genel muayene',
      notes: '',
      recordedAt: '2026-10-12',
      attachments: [],
      sourceDraftReviewId: '',
      createdAt: '2026-10-13T08:30:00.000Z',
      vaccination: undefined,
      prescription: undefined,
      labResult: undefined,
    });
  });

  it('aşı kaydı ve ek', () => {
    const record = toProtoRecord(
      recordRow({
        type: RecordType.VACCINATION,
        sourceDraftReviewId: 'taslak-1',
        vaccination: {
          id: 'asi-1',
          recordId: 'kayit-1',
          vaccineName: 'Kuduz',
          batchNumber: null,
          administeredAt: new Date('2026-10-12T00:00:00.000Z'),
          nextDueAt: null,
        },
        attachments: [
          {
            recordId: 'kayit-1',
            documentId: 'belge-1',
            document: documentRow(),
          },
        ],
      }),
    );
    expect(record.type).toBe(medicalRecord.RecordType.VACCINATION);
    expect(record.vaccination).toEqual({
      vaccineName: 'Kuduz',
      batchNumber: '',
      administeredAt: '2026-10-12',
      nextDueAt: '',
    });
    expect(record.attachments).toEqual([toFileReference(documentRow())]);
    expect(record.sourceDraftReviewId).toBe('taslak-1');
  });

  it('reçete kaydı', () => {
    const record = toProtoRecord(
      recordRow({
        type: RecordType.PRESCRIPTION,
        prescription: {
          id: 'recete-1',
          recordId: 'kayit-1',
          medicationName: 'Amoksisilin',
          dosage: '250 mg',
          frequency: 'günde 2 kez',
          durationDays: 7,
          instructions: null,
          prescribedAt: new Date('2026-10-12T00:00:00.000Z'),
        },
      }),
    );
    expect(record.prescription).toEqual({
      medicationName: 'Amoksisilin',
      dosage: '250 mg',
      frequency: 'günde 2 kez',
      durationDays: 7,
      instructions: '',
      prescribedAt: '2026-10-12',
    });
  });

  it('tahlil kaydı: satırlar, bayraklar (null → UNSPECIFIED) ve örnek tarihi', () => {
    const sampledAt = new Date('2026-10-10T00:00:00.000Z');
    const record = toProtoRecord(
      recordRow({
        type: RecordType.LAB_RESULT,
        labResults: [
          {
            id: 'l1',
            recordId: 'kayit-1',
            testName: 'ALT',
            value: '40',
            unit: null,
            referenceRange: null,
            flag: null,
            sampledAt,
          },
          {
            id: 'l2',
            recordId: 'kayit-1',
            testName: 'Glukoz',
            value: '180',
            unit: 'mg/dL',
            referenceRange: '70-140',
            flag: LabResultFlag.HIGH,
            sampledAt,
          },
        ],
      }),
    );
    expect(record.labResult).toEqual({
      sampledAt: '2026-10-10',
      items: [
        {
          testName: 'ALT',
          value: '40',
          unit: '',
          referenceRange: '',
          flag: medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
        },
        {
          testName: 'Glukoz',
          value: '180',
          unit: 'mg/dL',
          referenceRange: '70-140',
          flag: medicalRecord.LabResultFlag.HIGH,
        },
      ],
    });
  });
});

// ---Amaç: tipli satırların hayvan ve klinik bilgisini kayıttan aldığını doğrulamak ---
describe('tipli satırlar', () => {
  it('aşı', () => {
    const row: VaccinationWithRecord = {
      id: 'asi-1',
      recordId: 'kayit-1',
      vaccineName: 'Kuduz',
      batchNumber: 'B-1',
      administeredAt: new Date('2026-10-12T00:00:00.000Z'),
      nextDueAt: new Date('2027-10-12T00:00:00.000Z'),
      ...owner,
    };
    expect(toProtoVaccination(row)).toEqual({
      id: 'asi-1',
      recordId: 'kayit-1',
      petId: PET_ID,
      clinicId: CLINIC_ID,
      vaccineName: 'Kuduz',
      batchNumber: 'B-1',
      administeredAt: '2026-10-12',
      nextDueAt: '2027-10-12',
    });
  });

  it('reçete', () => {
    const row: PrescriptionWithRecord = {
      id: 'recete-1',
      recordId: 'kayit-1',
      medicationName: 'Amoksisilin',
      dosage: '250 mg',
      frequency: 'günde 2 kez',
      durationDays: 7,
      instructions: 'Yemekten sonra',
      prescribedAt: new Date('2026-10-12T00:00:00.000Z'),
      ...owner,
    };
    expect(toProtoPrescription(row)).toMatchObject({
      petId: PET_ID,
      clinicId: CLINIC_ID,
      instructions: 'Yemekten sonra',
      prescribedAt: '2026-10-12',
    });
  });

  it('tahlil', () => {
    const row: LabResultWithRecord = {
      id: 'l1',
      recordId: 'kayit-1',
      testName: 'Hemoglobin',
      value: '13.5',
      unit: 'g/dL',
      referenceRange: '12-18',
      flag: LabResultFlag.NORMAL,
      sampledAt: new Date('2026-10-10T00:00:00.000Z'),
      ...owner,
    };
    expect(toProtoLabResult(row)).toMatchObject({
      petId: PET_ID,
      clinicId: CLINIC_ID,
      flag: medicalRecord.LabResultFlag.NORMAL,
      sampledAt: '2026-10-10',
    });
  });
});

// ---Amaç: taslağın önerisini, onaylanan içeriğini ve kaynak dosyasını doğru taşıdığını doğrulamak ---
describe('toProtoDraft', () => {
  const proposal = {
    type: 1,
    title: 'Kontrol',
    notes: '',
    recordedAt: '2026-10-12',
  };
  const draftRow = (
    over: Partial<DraftWithDocument> = {},
  ): DraftWithDocument => ({
    id: 'taslak-1',
    documentId: 'belge-1',
    petId: PET_ID,
    clinicId: CLINIC_ID,
    recordType: RecordType.EXAMINATION,
    proposedPayload: proposal,
    approvedPayload: null,
    modelVersion: 'model-1',
    confidence: 0.9,
    status: DraftReviewStatus.PENDING,
    reviewNote: null,
    reviewedByClinicId: null,
    reviewedAt: null,
    createdRecordId: null,
    createdAt: CREATED,
    document: documentRow(),
    ...over,
  });

  it('bekleyen taslak', () => {
    expect(toProtoDraft(draftRow())).toEqual({
      id: 'taslak-1',
      petId: PET_ID,
      clinicId: CLINIC_ID,
      sourceFiles: [toFileReference(documentRow())],
      status: medicalRecord.DraftReviewStatus.PENDING,
      reviewNote: '',
      createdRecordId: '',
      createdAt: '2026-10-13T08:30:00.000Z',
      reviewedAt: '',
      reviewedByClinicId: '',
      documentId: 'belge-1',
      proposal,
      approvedContent: undefined,
      modelVersion: 'model-1',
      confidence: 0.9,
    });
  });

  it.each([
    [DraftReviewStatus.APPROVED, medicalRecord.DraftReviewStatus.APPROVED],
    [DraftReviewStatus.REJECTED, medicalRecord.DraftReviewStatus.REJECTED],
  ])(
    '%s taslak: inceleme bilgileri ve düzeltilmiş içerik',
    (status, expected) => {
      const approved = { ...proposal, type: 5, title: 'Kısırlaştırma' };
      expect(
        toProtoDraft(
          draftRow({
            status,
            approvedPayload: approved,
            reviewNote: 'not',
            reviewedByClinicId: CLINIC_ID,
            reviewedAt: CREATED,
            createdRecordId: 'kayit-1',
          }),
        ),
      ).toMatchObject({
        status: expected,
        approvedContent: approved,
        reviewNote: 'not',
        reviewedByClinicId: CLINIC_ID,
        reviewedAt: '2026-10-13T08:30:00.000Z',
        createdRecordId: 'kayit-1',
      });
    },
  );
});

// ---Amaç: doğrulanmış içeriğin kayıt ve tipli satır oluşturma verisine çevrildiğini doğrulamak ---
describe('toRecordContentData', () => {
  const base = { title: 'Başlık', notes: undefined, recordedAt: '2026-10-12' };

  it('muayene: tipli satır yok, boş not null', () => {
    expect(
      toRecordContentData({
        ...base,
        type: medicalRecord.RecordType.EXAMINATION,
      } as unknown as RecordContentDto),
    ).toEqual({
      type: RecordType.EXAMINATION,
      title: 'Başlık',
      notes: null,
      recordedAt: new Date('2026-10-12T00:00:00.000Z'),
    });
  });

  it('aşı: isteğe bağlı alanlar null', () => {
    const data = toRecordContentData({
      ...base,
      type: medicalRecord.RecordType.VACCINATION,
      vaccination: { vaccineName: 'Kuduz', administeredAt: '2026-10-12' },
    } as unknown as RecordContentDto);
    expect(data.type).toBe(RecordType.VACCINATION);
    expect(data.vaccination).toEqual({
      create: {
        vaccineName: 'Kuduz',
        batchNumber: null,
        administeredAt: new Date('2026-10-12T00:00:00.000Z'),
        nextDueAt: null,
      },
    });
  });

  it('reçete', () => {
    const data = toRecordContentData({
      ...base,
      type: medicalRecord.RecordType.PRESCRIPTION,
      prescription: {
        medicationName: 'Amoksisilin',
        dosage: '250 mg',
        frequency: 'günde 2 kez',
        durationDays: 7,
        prescribedAt: '2026-10-12',
      },
    } as unknown as RecordContentDto);
    expect(data.prescription).toEqual({
      create: {
        medicationName: 'Amoksisilin',
        dosage: '250 mg',
        frequency: 'günde 2 kez',
        durationDays: 7,
        instructions: null,
        prescribedAt: new Date('2026-10-12T00:00:00.000Z'),
      },
    });
  });

  it('tahlil: her satıra örnek tarihi yazılır, UNSPECIFIED ve eksik bayrak null olur', () => {
    const data = toRecordContentData({
      ...base,
      type: medicalRecord.RecordType.LAB_RESULT,
      labResult: {
        sampledAt: '2026-10-10',
        items: [
          {
            testName: 'ALT',
            value: '40',
            flag: medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
          },
          {
            testName: 'Glukoz',
            value: '180',
            unit: 'mg/dL',
            flag: medicalRecord.LabResultFlag.HIGH,
          },
          { testName: 'Üre', value: '30' },
        ],
      },
    } as unknown as RecordContentDto);
    expect(data.labResults).toEqual({
      create: [
        {
          testName: 'ALT',
          value: '40',
          unit: null,
          referenceRange: null,
          flag: null,
          sampledAt: new Date('2026-10-10T00:00:00.000Z'),
        },
        {
          testName: 'Glukoz',
          value: '180',
          unit: 'mg/dL',
          referenceRange: null,
          flag: LabResultFlag.HIGH,
          sampledAt: new Date('2026-10-10T00:00:00.000Z'),
        },
        {
          testName: 'Üre',
          value: '30',
          unit: null,
          referenceRange: null,
          flag: null,
          sampledAt: new Date('2026-10-10T00:00:00.000Z'),
        },
      ],
    });
  });

  it('geçersiz kayıt türünde hata fırlatır', () => {
    expect(() =>
      toRecordContentData({
        ...base,
        type: medicalRecord.RecordType.RECORD_TYPE_UNSPECIFIED,
      } as unknown as RecordContentDto),
    ).toThrow('geçersiz kayıt türü');
  });
});

describe('toLabExplanationPetContext', () => {
  const pet = (over: Partial<pets.Pet> = {}): pets.Pet => ({
    id: PET_ID,
    name: 'Pamuk',
    species: 'CAT',
    breed: 'TURKISH_VAN',
    sex: pets.PetSex.FEMALE,
    birthDate: '2019-05-01',
    isBirthDateEstimated: true,
    isNeutered: false,
    ownerUserId: 'sahip-1',
    chipNumberMasked: '****1234',
    chipNumber: '900000000001234',
    createdAt: CREATED.toISOString(),
    updatedAt: CREATED.toISOString(),
    ...over,
  });

  it('yalnızca tür, doğum tarihi ve tahmini mi bilgisi alınır', () =>
    expect(toLabExplanationPetContext(pet())).toEqual({
      species: 'CAT',
      birthDate: '2019-05-01',
      isBirthDateEstimated: true,
    }));

  it('zaman içeren geçerli tarih YYYY-AA-GG olur', () =>
    expect(
      toLabExplanationPetContext(pet({ birthDate: '2019-05-01T00:00:00.000Z' }))
        .birthDate,
    ).toBe('2019-05-01'));

  it.each([
    ['boş', ''],
    ['geçersiz', 'dün'],
  ])('%s doğum tarihi boş kalır', (_n, birthDate) =>
    expect(toLabExplanationPetContext(pet({ birthDate })).birthDate).toBe(''),
  );

  it('hayvan yoksa boş bağlam döner', () =>
    expect(toLabExplanationPetContext(undefined)).toEqual(EMPTY_PET_CONTEXT));
});

describe('toLabExplanationRequestedData', () => {
  it('kaydın kalemleri ad olarak bayrakla, notsuz ve kimliksiz taşınır', () => {
    const sampledAt = new Date('2026-10-10T00:00:00.000Z');
    const record = recordRow({
      id: 'kayit-1',
      type: RecordType.LAB_RESULT,
      title: 'Kan tahlili',
      notes: 'Gizli not',
      labResults: [
        {
          id: 'l1',
          recordId: 'kayit-1',
          testName: 'ALT',
          value: '142',
          unit: 'U/L',
          referenceRange: '12-130',
          flag: LabResultFlag.HIGH,
          sampledAt,
        },
        {
          id: 'l2',
          recordId: 'kayit-1',
          testName: 'Üre',
          value: '30',
          unit: null,
          referenceRange: null,
          flag: null,
          sampledAt,
        },
      ],
    });

    expect(
      toLabExplanationRequestedData(record, {
        species: 'DOG',
        birthDate: '2020-01-02',
        isBirthDateEstimated: false,
      }),
    ).toEqual({
      recordId: 'kayit-1',
      title: 'Kan tahlili',
      sampledAt: '2026-10-10',
      species: 'DOG',
      birthDate: '2020-01-02',
      isBirthDateEstimated: false,
      items: [
        {
          testName: 'ALT',
          value: '142',
          unit: 'U/L',
          referenceRange: '12-130',
          flag: 'HIGH',
        },
        {
          testName: 'Üre',
          value: '30',
          unit: '',
          referenceRange: '',
          flag: 'LAB_RESULT_FLAG_UNSPECIFIED',
        },
      ],
    });
  });
});

describe('toProtoLabExplanation', () => {
  const row = (
    over: Partial<LabResultExplanation> = {},
  ): LabResultExplanation => ({
    id: 'aciklama-1',
    recordId: 'kayit-1',
    status: LabExplanationStatus.PENDING,
    summary: null,
    items: null,
    confidence: null,
    modelVersion: null,
    failureReason: null,
    requestedAt: CREATED,
    generatedAt: null,
    ...over,
  });
  const onlyStatus = (status: medicalRecord.LabExplanationStatus) => ({
    status,
    summary: '',
    items: [],
    confidence: 0,
    generatedAt: '',
  });

  it.each([
    [
      LabExplanationStatus.PENDING,
      medicalRecord.LabExplanationStatus.LAB_EXPLANATION_PENDING,
    ],
    [
      LabExplanationStatus.FAILED,
      medicalRecord.LabExplanationStatus.LAB_EXPLANATION_FAILED,
    ],
  ])('%s → yalnızca durum döner', (status, expected) =>
    expect(
      toProtoLabExplanation(
        row({
          status,
          failureReason: 'INVALID_AI_OUTPUT',
          modelVersion: 'model-1',
          summary: 'eski',
          confidence: 0.4,
        }),
      ),
    ).toEqual(onlyStatus(expected)),
  );

  it('READY → özet, kalemler, güven ve ISO üretim zamanı', () =>
    expect(
      toProtoLabExplanation(
        row({
          status: LabExplanationStatus.READY,
          summary: 'Özet',
          items: [{ testName: 'ALT', explanation: 'Açıklama' }],
          confidence: 0.82,
          generatedAt: new Date('2026-10-21T09:30:09.000Z'),
        }),
      ),
    ).toEqual({
      status: medicalRecord.LabExplanationStatus.LAB_EXPLANATION_READY,
      summary: 'Özet',
      items: [{ testName: 'ALT', explanation: 'Açıklama' }],
      confidence: 0.82,
      generatedAt: '2026-10-21T09:30:09.000Z',
    }));

  it('READY ve kalemsiz → boş liste', () =>
    expect(
      toProtoLabExplanation(
        row({
          status: LabExplanationStatus.READY,
          summary: 'Özet',
          items: [],
          confidence: 0,
          generatedAt: CREATED,
        }),
      ).items,
    ).toEqual([]));
});
