import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { nestedErrors } from '../../../testing/nested-errors';
import { CreateRecordRequestDto } from './create-record.dto';
import {
  GetDocumentFileRequestDto,
  GetDocumentRequestDto,
} from './get-document.dto';
import { GetLabExplanationRequestDto } from './get-lab-explanation.dto';
import { ListDocumentsByPetRequestDto } from './list-documents-by-pet.dto';
import { ListDraftReviewsRequestDto } from './list-draft-reviews.dto';
import { ListLabResultsRequestDto } from './list-lab-results.dto';
import { ListPrescriptionsRequestDto } from './list-prescriptions.dto';
import { ListRecordsByPetRequestDto } from './list-records-by-pet.dto';
import { ListVaccinationsRequestDto } from './list-vaccinations.dto';
import { RegisterDocumentRequestDto } from './register-document.dto';
import { ReviewDraftRequestDto } from './review-draft.dto';

const { RecordType, LabResultFlag, DraftReviewStatus, DocumentStatus } =
  medicalRecord;
const FILE_UUID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SHA = 'a'.repeat(64);

// ---Amaç: Türkiye saatine göre bugünün tarihini YYYY-AA-GG olarak üretmek ---
const istanbulToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

// ---Amaç: YYYY-AA-GG tarihine gün eklemek veya çıkarmak ---
const shiftDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const today = istanbulToday();
const yesterday = shiftDays(today, -1);
const tomorrow = shiftDays(today, 1);

const examination = {
  type: RecordType.EXAMINATION,
  title: 'Genel muayene',
  notes: 'Kilo normal.\nAteş yok.',
  recordedAt: yesterday,
};

const vaccinationDetails = {
  vaccineName: 'Kuduz',
  batchNumber: 'B-123',
  administeredAt: yesterday,
  nextDueAt: shiftDays(today, 365),
};

const prescriptionDetails = {
  medicationName: 'Amoksisilin',
  dosage: '250 mg',
  frequency: 'günde 2 kez',
  durationDays: 7,
  instructions: 'Yemekten sonra.\nSu ile.',
  prescribedAt: today,
};

const labItem = {
  testName: 'Hemoglobin',
  value: '13.5',
  unit: 'g/dL',
  referenceRange: '12-18',
  flag: LabResultFlag.NORMAL,
};

const labDetails = { items: [labItem], sampledAt: yesterday };

// ---Amaç: CreateRecord isteğini verilen içerikle doğrulayıp iç içe alan hatalarını döndürmek ---
const createRecord = (content: object | null, extra: object = {}) =>
  nestedErrors(CreateRecordRequestDto, { petId: UUID_A, content, ...extra });

// ---Amaç: kayıt içeriğinin tür, başlık, not ve tarih kurallarını doğrulamak ---
describe('RecordContentDto — ortak alanlar', () => {
  it('ayrıntısız muayene kaydı geçerlidir', () =>
    expect(createRecord(examination)).toEqual({}));

  it.each([
    [
      'UNSPECIFIED (gRPC varsayılanı)',
      RecordType.RECORD_TYPE_UNSPECIFIED,
      V.NOT_VALID,
    ],
    ['UNRECOGNIZED', RecordType.UNRECOGNIZED, V.NOT_VALID],
    ['tanımsız sayı', 99, V.NOT_VALID],
    ['metin', 'EXAMINATION', V.NOT_VALID],
    ['gönderilmedi', undefined, V.NOT_EMPTY],
  ])('type %s → hata', (_n, type, expected) =>
    expect(createRecord({ ...examination, type })).toEqual({
      'content.type': msg(P.RECORD_TYPE, expected),
    }),
  );

  it.each([
    ['boş', '', msg(P.TITLE, V.NOT_EMPTY)],
    ['yalnızca boşluk', '   ', msg(P.TITLE, V.NOT_EMPTY)],
    ['1 karakter', 'a', msg(P.TITLE, V.MIN_LENGTH, 2)],
    ['129 karakter', 'a'.repeat(129), msg(P.TITLE, V.MAX_LENGTH, 128)],
    ['satır sonu içerir', 'Genel\nmuayene', msg(P.TITLE, V.WRONG_DATA_FORMAT)],
    ['sekme içerir', 'Genel\tmuayene', msg(P.TITLE, V.WRONG_DATA_FORMAT)],
    ['metin değil', 12, msg(P.TITLE, V.MUST_BE_STRING)],
  ])('title %s → hata', (_n, title, expected) =>
    expect(createRecord({ ...examination, title })).toEqual({
      'content.title': expected,
    }),
  );

  it('title baştaki ve sondaki boşluklardan arındırılır, 128 karakter kabul edilir', () => {
    const dto = plainToInstance(CreateRecordRequestDto, {
      petId: UUID_A,
      content: { ...examination, title: `  ${'a'.repeat(128)}  ` },
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.content.title).toBe('a'.repeat(128));
  });

  it.each([
    ['boş', ''],
    ['yalnızca boşluk', '   '],
    ['gönderilmedi', undefined],
  ])('notes %s → opsiyonel, kabul edilir', (_n, notes) =>
    expect(createRecord({ ...examination, notes })).toEqual({}),
  );

  it.each([
    ['2001 karakter', 'a'.repeat(2001), msg(P.NOTES, V.MAX_LENGTH, 2000)],
    ['sekme içerir', 'a\tb', msg(P.NOTES, V.WRONG_DATA_FORMAT)],
    ['NUL içerir', 'a\u0000b', msg(P.NOTES, V.WRONG_DATA_FORMAT)],
  ])('notes %s → hata', (_n, notes, expected) =>
    expect(createRecord({ ...examination, notes })).toEqual({
      'content.notes': expected,
    }),
  );

  it('notes satır sonu (\\n, \\r\\n) içerebilir', () =>
    expect(createRecord({ ...examination, notes: 'a\r\nb\nc' })).toEqual({}));

  it.each([
    ['boş', '', msg(P.RECORDED_AT, V.NOT_EMPTY)],
    [
      'saatli ISO',
      `${yesterday}T10:00:00Z`,
      msg(P.RECORDED_AT, V.MUST_BE_DATE),
    ],
    ['olmayan gün', '2025-02-30', msg(P.RECORDED_AT, V.MUST_BE_DATE)],
    ['eksik hane', '2025-1-5', msg(P.RECORDED_AT, V.MUST_BE_DATE)],
    ['gelecek', tomorrow, msg(P.RECORDED_AT, V.CANNOT_BE_FUTURE)],
  ])('recordedAt %s → hata', (_n, recordedAt, expected) =>
    expect(createRecord({ ...examination, recordedAt })).toEqual({
      'content.recordedAt': expected,
    }),
  );

  it('recordedAt bugün kabul edilir', () =>
    expect(createRecord({ ...examination, recordedAt: today })).toEqual({}));
});

// ---Amaç: kayıt türü ile ayrıntı (oneof) alanının birebir uyumunu doğrulamak ---
describe('RecordContentDto — tür/ayrıntı uyumu', () => {
  it.each([
    [
      'VACCINATION + vaccination',
      RecordType.VACCINATION,
      { vaccination: vaccinationDetails },
    ],
    [
      'PRESCRIPTION + prescription',
      RecordType.PRESCRIPTION,
      { prescription: prescriptionDetails },
    ],
    [
      'LAB_RESULT + labResult',
      RecordType.LAB_RESULT,
      { labResult: labDetails },
    ],
    ['SURGERY ayrıntısız', RecordType.SURGERY, {}],
  ])('%s → geçerli', (_n, type, details) =>
    expect(createRecord({ ...examination, type, ...details })).toEqual({}),
  );

  it.each([
    ['VACCINATION', RecordType.VACCINATION, 'vaccination', P.VACCINATION],
    ['PRESCRIPTION', RecordType.PRESCRIPTION, 'prescription', P.PRESCRIPTION],
    ['LAB_RESULT', RecordType.LAB_RESULT, 'labResult', P.LAB_RESULT],
  ])('%s ayrıntısız → NOT_EMPTY', (_n, type, field, prefix) =>
    expect(createRecord({ ...examination, type })).toEqual({
      [`content.${field}`]: msg(prefix, V.NOT_EMPTY),
    }),
  );

  it('ayrıntı null gelirse (gRPC) gönderilmemiş sayılır', () =>
    expect(
      createRecord({
        ...examination,
        type: RecordType.VACCINATION,
        vaccination: null,
      }),
    ).toEqual({ 'content.vaccination': msg(P.VACCINATION, V.NOT_EMPTY) }));

  it.each([
    [
      'EXAMINATION + vaccination',
      RecordType.EXAMINATION,
      { vaccination: vaccinationDetails },
      'vaccination',
      P.VACCINATION,
    ],
    [
      'SURGERY + labResult',
      RecordType.SURGERY,
      { labResult: labDetails },
      'labResult',
      P.LAB_RESULT,
    ],
    [
      'VACCINATION + prescription',
      RecordType.VACCINATION,
      { vaccination: vaccinationDetails, prescription: prescriptionDetails },
      'prescription',
      P.PRESCRIPTION,
    ],
  ])('%s → uyumsuz ayrıntı NOT_VALID', (_n, type, details, field, prefix) =>
    expect(createRecord({ ...examination, type, ...details })).toEqual({
      [`content.${field}`]: msg(prefix, V.NOT_VALID),
    }),
  );

  it('ayrıntı nesne değilse → WRONG_DATA_TYPE', () =>
    expect(
      createRecord({
        ...examination,
        type: RecordType.VACCINATION,
        vaccination: 'Kuduz',
      }),
    ).toEqual({
      'content.vaccination': msg(P.VACCINATION, V.WRONG_DATA_TYPE),
    }));
});

// ---Amaç: aşı ayrıntısının ad, seri no ve tarih sırası kurallarını doğrulamak ---
describe('VaccinationDetailsDto', () => {
  const check = (o: object) =>
    createRecord({
      ...examination,
      type: RecordType.VACCINATION,
      vaccination: { ...vaccinationDetails, ...o },
    });

  it.each([
    ['batchNumber boş', { batchNumber: '' }],
    ['nextDueAt boş', { nextDueAt: '' }],
    ['nextDueAt gönderilmedi', { nextDueAt: undefined }],
    [
      'nextDueAt geçmişte ama uygulamadan sonra',
      {
        administeredAt: shiftDays(today, -30),
        nextDueAt: shiftDays(today, -10),
      },
    ],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it.each([
    [
      'vaccineName boş',
      { vaccineName: '' },
      'vaccineName',
      msg(P.VACCINE_NAME, V.NOT_EMPTY),
    ],
    [
      'vaccineName 129',
      { vaccineName: 'a'.repeat(129) },
      'vaccineName',
      msg(P.VACCINE_NAME, V.MAX_LENGTH, 128),
    ],
    [
      'batchNumber 65',
      { batchNumber: 'a'.repeat(65) },
      'batchNumber',
      msg(P.BATCH_NUMBER, V.MAX_LENGTH, 64),
    ],
    [
      'administeredAt gelecek',
      { administeredAt: tomorrow, nextDueAt: '' },
      'administeredAt',
      msg(P.ADMINISTERED_AT, V.CANNOT_BE_FUTURE),
    ],
    [
      'nextDueAt uygulama günüyle aynı',
      { nextDueAt: yesterday },
      'nextDueAt',
      msg(P.NEXT_DUE_AT, V.NOT_VALID),
    ],
    [
      'nextDueAt uygulamadan önce',
      { nextDueAt: shiftDays(today, -2) },
      'nextDueAt',
      msg(P.NEXT_DUE_AT, V.NOT_VALID),
    ],
    [
      'nextDueAt hatalı biçim',
      { nextDueAt: '01.01.2030' },
      'nextDueAt',
      msg(P.NEXT_DUE_AT, V.MUST_BE_DATE),
    ],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [`content.vaccination.${field}`]: expected }),
  );
});

// ---Amaç: reçete ayrıntısının zorunlu alanlarını, gün aralığını ve çok satırlı talimatı doğrulamak ---
describe('PrescriptionDetailsDto', () => {
  const check = (o: object) =>
    createRecord({
      ...examination,
      type: RecordType.PRESCRIPTION,
      prescription: { ...prescriptionDetails, ...o },
    });

  it.each([
    ['instructions boş', { instructions: '' }],
    ['durationDays 365', { durationDays: 365 }],
    ['durationDays metin "7" (sorgu)', { durationDays: '7' }],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it.each([
    ['dosage boş', { dosage: '' }, 'dosage', msg(P.DOSAGE, V.NOT_EMPTY)],
    [
      'frequency 65',
      { frequency: 'a'.repeat(65) },
      'frequency',
      msg(P.FREQUENCY, V.MAX_LENGTH, 64),
    ],
    [
      'medicationName yok',
      { medicationName: undefined },
      'medicationName',
      msg(P.MEDICATION_NAME, V.NOT_EMPTY),
    ],
    [
      'durationDays 0 (gRPC varsayılanı)',
      { durationDays: 0 },
      'durationDays',
      msg(P.DURATION_DAYS, V.MIN, 1),
    ],
    [
      'durationDays 366',
      { durationDays: 366 },
      'durationDays',
      msg(P.DURATION_DAYS, V.MAX, 365),
    ],
    [
      'durationDays 1.5',
      { durationDays: 1.5 },
      'durationDays',
      msg(P.DURATION_DAYS, V.MUST_BE_NUMBER),
    ],
    [
      'instructions 1001',
      { instructions: 'a'.repeat(1001) },
      'instructions',
      msg(P.INSTRUCTIONS, V.MAX_LENGTH, 1000),
    ],
    [
      'prescribedAt gelecek',
      { prescribedAt: tomorrow },
      'prescribedAt',
      msg(P.PRESCRIBED_AT, V.CANNOT_BE_FUTURE),
    ],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [`content.prescription.${field}`]: expected }),
  );
});

// ---Amaç: tahlil ayrıntısının satır sayısı, satır alanları ve bayrak kurallarını doğrulamak ---
describe('LabResultDetailsDto', () => {
  const check = (details: object) =>
    createRecord({
      ...examination,
      type: RecordType.LAB_RESULT,
      labResult: { ...labDetails, ...details },
    });
  const checkItem = (o: object) => check({ items: [{ ...labItem, ...o }] });

  it.each([
    [
      'flag UNSPECIFIED (gRPC varsayılanı)',
      { flag: LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED },
    ],
    ['flag gönderilmedi', { flag: undefined }],
    ['flag HIGH', { flag: LabResultFlag.HIGH }],
    ['unit ve referenceRange boş', { unit: '', referenceRange: '' }],
  ])('%s → geçerli', (_n, o) => expect(checkItem(o)).toEqual({}));

  it('50 satır kabul edilir', () =>
    expect(check({ items: Array.from({ length: 50 }, () => labItem) })).toEqual(
      {},
    ));

  it.each([
    ['boş liste', [], msg(P.LAB_RESULT_ITEMS, V.MIN, 1)],
    [
      '51 satır',
      Array.from({ length: 51 }, () => labItem),
      msg(P.LAB_RESULT_ITEMS, V.MAX, 50),
    ],
    ['liste değil', 'Hemoglobin', msg(P.LAB_RESULT_ITEMS, V.MUST_BE_ARRAY)],
  ])('items %s → hata', (_n, items, expected) =>
    expect(check({ items })).toMatchObject({
      'content.labResult.items': expected,
    }),
  );

  it.each([
    [
      'testName boş',
      { testName: '' },
      'testName',
      msg(P.TEST_NAME, V.NOT_EMPTY),
    ],
    ['value boş', { value: '' }, 'value', msg(P.LAB_VALUE, V.NOT_EMPTY)],
    [
      'unit 33',
      { unit: 'a'.repeat(33) },
      'unit',
      msg(P.LAB_UNIT, V.MAX_LENGTH, 32),
    ],
    [
      'referenceRange 65',
      { referenceRange: 'a'.repeat(65) },
      'referenceRange',
      msg(P.REFERENCE_RANGE, V.MAX_LENGTH, 64),
    ],
    ['flag tanımsız', { flag: 4 }, 'flag', msg(P.LAB_RESULT_FLAG, V.NOT_VALID)],
  ])('satır %s → hata', (_n, o, field, expected) =>
    expect(checkItem(o)).toEqual({
      [`content.labResult.items.0.${field}`]: expected,
    }),
  );

  it('sampledAt gelecek → hata', () =>
    expect(check({ sampledAt: tomorrow })).toEqual({
      'content.labResult.sampledAt': msg(P.SAMPLED_AT, V.CANNOT_BE_FUTURE),
    }));
});

// ---Amaç: elle kayıt isteğinin hayvan, içerik ve yalnızca document_id taşıyan ek kurallarını doğrulamak ---
describe('CreateRecordRequestDto', () => {
  it.each([
    ['null (gRPC varsayılanı)', null, msg(P.CONTENT, V.NOT_EMPTY)],
    ['metin', 'muayene', msg(P.CONTENT, V.WRONG_DATA_TYPE)],
  ])('content %s → hata', (_n, content, expected) =>
    expect(createRecord(content as object | null)).toEqual({
      content: expected,
    }),
  );

  it('petId UUID değilse → hata', () =>
    expect(createRecord(examination, { petId: 'abc' })).toEqual({
      petId: msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    }));

  it.each([
    ['gönderilmedi', undefined],
    ['boş liste (gRPC varsayılanı)', []],
    [
      '10 farklı belge',
      Array.from({ length: 10 }, (_v, i) => ({
        documentId: `9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c${(10 + i).toString(16).padStart(2, '0')}`,
      })),
    ],
  ])('attachments %s → geçerli', (_n, attachments) =>
    expect(createRecord(examination, { attachments })).toEqual({}),
  );

  it.each([
    [
      '11 belge',
      Array.from({ length: 11 }, () => ({ documentId: FILE_UUID })),
      msg(P.ATTACHMENTS, V.MAX, 10),
    ],
    [
      'aynı belge iki kez',
      [{ documentId: FILE_UUID }, { documentId: FILE_UUID }],
      msg(P.ATTACHMENTS, V.MUST_BE_UNIQUE),
    ],
    ['liste değil', FILE_UUID, msg(P.ATTACHMENTS, V.MUST_BE_ARRAY)],
  ])('attachments %s → hata', (_n, attachments, expected) =>
    expect(createRecord(examination, { attachments })).toMatchObject({
      attachments: expected,
    }),
  );

  it('ek documentId UUID değilse → hata', () =>
    expect(
      createRecord(examination, { attachments: [{ documentId: 'x' }] }),
    ).toEqual({
      'attachments.0.documentId': msg(P.DOCUMENT_ID, V.WRONG_DATA_FORMAT),
    }));

  it('ekteki istemci alanları (storagePath vb.) atılır, yalnızca documentId kalır', () => {
    const dto = plainToInstance(CreateRecordRequestDto, {
      petId: UUID_A,
      content: examination,
      attachments: [
        { documentId: FILE_UUID, storagePath: 'x.pdf', sizeBytes: 5 },
      ],
    });
    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto.attachments).toEqual([{ documentId: FILE_UUID }]);
  });
});

// ---Amaç: taslak onay/red isteğinde not ve düzeltilmiş içerik kurallarını doğrulamak ---
describe('ReviewDraftRequestDto', () => {
  const check = (o: object) =>
    nestedErrors(ReviewDraftRequestDto, { id: UUID_A, approved: true, ...o });

  it.each([
    ['onay, not ve içerik yok', {}],
    ['onay, gRPC varsayılanları', { reviewNote: '', editedContent: null }],
    ['onay, düzeltilmiş içerikle', { editedContent: examination }],
    ['onay, notla', { reviewNote: 'Kontrol edildi' }],
    ['red, notla', { approved: false, reviewNote: 'Belge okunaksız' }],
    [
      'red, gRPC varsayılanı içerik null',
      { approved: false, reviewNote: 'Yanlış hayvan', editedContent: null },
    ],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it.each([
    [
      'red, not yok',
      { approved: false },
      'reviewNote',
      msg(P.REVIEW_NOTE, V.NOT_EMPTY),
    ],
    [
      'red, not boş (gRPC)',
      { approved: false, reviewNote: '' },
      'reviewNote',
      msg(P.REVIEW_NOTE, V.NOT_EMPTY),
    ],
    [
      'red, not yalnızca boşluk',
      { approved: false, reviewNote: '   ' },
      'reviewNote',
      msg(P.REVIEW_NOTE, V.NOT_EMPTY),
    ],
    [
      'red, düzeltilmiş içerikle',
      { approved: false, reviewNote: 'x', editedContent: examination },
      'editedContent',
      msg(P.EDITED_CONTENT, V.NOT_VALID),
    ],
    [
      'not 501',
      { reviewNote: 'a'.repeat(501) },
      'reviewNote',
      msg(P.REVIEW_NOTE, V.MAX_LENGTH, 500),
    ],
    [
      'not satır sonu içerir',
      { reviewNote: 'a\nb' },
      'reviewNote',
      msg(P.REVIEW_NOTE, V.WRONG_DATA_FORMAT),
    ],
    [
      'approved yok',
      { approved: undefined },
      'approved',
      msg(P.APPROVED, V.NOT_EMPTY),
    ],
    [
      'approved metin',
      { approved: 'true' },
      'approved',
      msg(P.APPROVED, V.MUST_BE_BOOLEAN),
    ],
    [
      'id UUID değil',
      { id: 'x' },
      'id',
      msg(P.DRAFT_REVIEW_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'içerik nesne değil',
      { editedContent: 'x' },
      'editedContent',
      msg(P.EDITED_CONTENT, V.WRONG_DATA_TYPE),
    ],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [field]: expected }),
  );

  it('onayda düzeltilmiş içerik tam doğrulanır', () =>
    expect(
      check({
        editedContent: { ...examination, type: RecordType.VACCINATION },
      }),
    ).toEqual({
      'editedContent.vaccination': msg(P.VACCINATION, V.NOT_EMPTY),
    }));
});

// ---Amaç: hayvan kayıt listesinin tür ve tarih filtreleriyle sayfalama kurallarını doğrulamak ---
describe('ListRecordsByPetRequestDto', () => {
  const valid = { petId: UUID_A, page: 1, pageSize: 16 };
  const check = (o: object) =>
    nestedErrors(ListRecordsByPetRequestDto, { ...valid, ...o });

  it.each([
    ['filtresiz', {}],
    ['gRPC varsayılanları (boş tarih)', { fromDate: '', toDate: '' }],
    ['aynı gün aralığı', { fromDate: yesterday, toDate: yesterday }],
    ['gelecek tarihli bitiş', { fromDate: yesterday, toDate: tomorrow }],
    ['sorgudan tür "2"', { type: '2' }],
    ['sorgudan sayfa "1" ve boyut "128"', { page: '1', pageSize: '128' }],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it('sorgudan gelen tür sayıya çevrilir, boş tür filtre sayılmaz', () => {
    expect(
      plainToInstance(ListRecordsByPetRequestDto, { ...valid, type: '2' }).type,
    ).toBe(RecordType.VACCINATION);
    expect(
      plainToInstance(ListRecordsByPetRequestDto, { ...valid, type: '' }).type,
    ).toBeUndefined();
  });

  it.each([
    ['tür UNSPECIFIED', { type: 0 }, 'type', msg(P.RECORD_TYPE, V.NOT_VALID)],
    ['tür harf', { type: 'abc' }, 'type', msg(P.RECORD_TYPE, V.NOT_VALID)],
    [
      'başlangıç bitişten sonra',
      { fromDate: today, toDate: yesterday },
      'toDate',
      msg(P.TO_DATE, V.NOT_VALID),
    ],
    [
      'başlangıç hatalı',
      { fromDate: '2025-13-01' },
      'fromDate',
      msg(P.FROM_DATE, V.MUST_BE_DATE),
    ],
    ['sayfa 0', { page: 0 }, 'page', msg(P.PAGE, V.MIN, 1)],
    [
      'sayfa boyutu 10',
      { pageSize: 10 },
      'pageSize',
      msg(P.PAGE_SIZE, V.NOT_VALID),
    ],
    [
      'sayfa boyutu harf',
      { pageSize: 'x' },
      'pageSize',
      msg(P.PAGE_SIZE, V.MUST_BE_NUMBER),
    ],
    ['petId yok', { petId: '' }, 'petId', msg(P.PET_ID, V.NOT_EMPTY)],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [field]: expected }),
  );
});

// ---Amaç: aşı, reçete ve tahlil listelerinin isteğe bağlı filtrelerini doğrulamak ---
describe('ListVaccinations / ListPrescriptions / ListLabResults', () => {
  const base = { petId: UUID_A, page: 1, pageSize: 8 };

  it.each([
    ['"true"', 'true', true],
    ['"false"', 'false', false],
    ['gönderilmedi', undefined, undefined],
  ])('onlyUpcoming %s → %s', (_n, onlyUpcoming, expected) => {
    expect(
      nestedErrors(ListVaccinationsRequestDto, { ...base, onlyUpcoming }),
    ).toEqual({});
    expect(
      plainToInstance(ListVaccinationsRequestDto, { ...base, onlyUpcoming })
        .onlyUpcoming,
    ).toBe(expected);
  });

  it('onlyUpcoming geçersiz → hata', () =>
    expect(
      nestedErrors(ListVaccinationsRequestDto, {
        ...base,
        onlyUpcoming: 'evet',
      }),
    ).toEqual({
      onlyUpcoming: msg(P.ONLY_UPCOMING, V.MUST_BE_BOOLEAN),
    }));

  it('onlyActive "false" → false, geçersiz → hata', () => {
    expect(
      plainToInstance(ListPrescriptionsRequestDto, {
        ...base,
        onlyActive: 'false',
      }).onlyActive,
    ).toBe(false);
    expect(
      nestedErrors(ListPrescriptionsRequestDto, { ...base, onlyActive: 1 }),
    ).toEqual({
      onlyActive: msg(P.ONLY_ACTIVE, V.MUST_BE_BOOLEAN),
    });
  });

  it.each([
    ['boş', '', {}],
    ['geçerli', 'Hemoglobin', {}],
    [
      '129 karakter',
      'a'.repeat(129),
      { testName: msg(P.TEST_NAME, V.MAX_LENGTH, 128) },
    ],
  ])('testName %s', (_n, testName, expected) =>
    expect(
      nestedErrors(ListLabResultsRequestDto, { ...base, testName }),
    ).toEqual(expected),
  );
});

// ---Amaç: taslak listesinin isteğe bağlı hayvan ve durum filtrelerini doğrulamak ---
describe('ListDraftReviewsRequestDto', () => {
  const base = { page: 1, pageSize: 32 };
  const check = (o: object) =>
    nestedErrors(ListDraftReviewsRequestDto, { ...base, ...o });

  it.each([
    ['filtresiz', {}],
    ['boş petId', { petId: '' }],
    ['petId ve durum', { petId: UUID_B, status: DraftReviewStatus.PENDING }],
    ['sorgudan durum "3"', { status: '3' }],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it.each([
    [
      'petId UUID değil',
      { petId: 'x' },
      'petId',
      msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'durum UNSPECIFIED',
      { status: 0 },
      'status',
      msg(P.DRAFT_REVIEW_STATUS, V.NOT_VALID),
    ],
    [
      'durum 4',
      { status: 4 },
      'status',
      msg(P.DRAFT_REVIEW_STATUS, V.NOT_VALID),
    ],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [field]: expected }),
  );
});

// ---Amaç: belge sorgusunda kimlik biçimini doğrulamak ---
describe('GetDocumentRequestDto', () => {
  it.each([
    ['geçerli', UUID_A, {}],
    ['boş', '', { id: msg(P.DOCUMENT_ID, V.NOT_EMPTY) }],
    ['UUID değil', 'abc', { id: msg(P.DOCUMENT_ID, V.WRONG_DATA_FORMAT) }],
  ])('id %s', (_n, id, expected) =>
    expect(nestedErrors(GetDocumentRequestDto, { id })).toEqual(expected),
  );
});

describe('GetLabExplanationRequestDto', () => {
  it.each([
    ['geçerli', UUID_A, {}],
    ['boş', '', { recordId: msg(P.RECORD_ID, V.NOT_EMPTY) }],
    ['UUID değil', 'abc', { recordId: msg(P.RECORD_ID, V.WRONG_DATA_FORMAT) }],
  ])('recordId %s', (_n, recordId, expected) =>
    expect(nestedErrors(GetLabExplanationRequestDto, { recordId })).toEqual(
      expected,
    ),
  );
});

// ---Amaç: dosya isteğinde yalnızca download=1'in indirme anlamına geldiğini, başka değerlerin reddedildiğini doğrulamak ---
describe('GetDocumentFileRequestDto', () => {
  const check = (o: object) =>
    nestedErrors(GetDocumentFileRequestDto, { id: UUID_A, ...o });

  it.each([
    ['gönderilmedi', {}, undefined],
    ['"1"', { download: '1' }, true],
  ])('download %s → geçerli, %p', (_n, o, expected) => {
    expect(check(o)).toEqual({});
    expect(
      plainToInstance(GetDocumentFileRequestDto, { id: UUID_A, ...o }).download,
    ).toBe(expected);
  });

  it.each(['0', 'true', '', 'evet'])('download "%s" → NOT_VALID', (download) =>
    expect(check({ download })).toEqual({
      download: msg(P.DOWNLOAD, V.NOT_VALID),
    }),
  );

  it('bozuk belge kimliği reddedilir', () =>
    expect(check({ id: 'abc' })).toEqual({
      id: msg(P.DOCUMENT_ID, V.WRONG_DATA_FORMAT),
    }));
});

// ---Amaç: belge listesinde hayvan kimliğinin zorunlu, durum filtresinin isteğe bağlı olduğunu ve sayfalama kurallarını doğrulamak ---
describe('ListDocumentsByPetRequestDto', () => {
  const base = { petId: UUID_A, page: 1, pageSize: 8 };
  const check = (o: object) =>
    nestedErrors(ListDocumentsByPetRequestDto, { ...base, ...o });

  it.each([
    ['filtresiz', {}],
    ['boş durum', { status: '' }],
    ['durum FAILED', { status: DocumentStatus.FAILED }],
    ['sorgudan durum "1"', { status: '1' }],
  ])('%s → geçerli', (_n, o) => expect(check(o)).toEqual({}));

  it.each([
    ['petId yok', { petId: undefined }, 'petId', msg(P.PET_ID, V.NOT_EMPTY)],
    [
      'petId UUID değil',
      { petId: 'x' },
      'petId',
      msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'durum UNSPECIFIED',
      { status: 0 },
      'status',
      msg(P.DOCUMENT_STATUS, V.NOT_VALID),
    ],
    ['durum 5', { status: '5' }, 'status', msg(P.DOCUMENT_STATUS, V.NOT_VALID)],
    [
      'sayfa boyutu 10',
      { pageSize: 10 },
      'pageSize',
      msg(P.PAGE_SIZE, V.NOT_VALID),
    ],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [field]: expected }),
  );
});

// ---Amaç: belge kaydı isteğinin UploadPetResult ile aynı dosya kurallarını uyguladığını ve clinicId taşımadığını doğrulamak ---
describe('RegisterDocumentRequestDto', () => {
  const valid = {
    petId: UUID_A,
    storagePath: `${FILE_UUID}.pdf`,
    originalName: 'kan-tahlili.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: SHA,
    note: '',
  };
  const check = (o: object) =>
    nestedErrors(RegisterDocumentRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it('clinicId gönderilse de atılır', () => {
    const dto = plainToInstance(RegisterDocumentRequestDto, {
      ...valid,
      clinicId: UUID_B,
    });
    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto).not.toHaveProperty('clinicId');
  });

  it.each([
    [
      'uzantı MIME ile uyumsuz',
      { storagePath: `${FILE_UUID}.png` },
      'storagePath',
      msg(P.STORAGE_PATH, V.NOT_VALID),
    ],
    [
      'yol klasör içerir',
      { storagePath: `documents/${FILE_UUID}.pdf` },
      'storagePath',
      msg(P.STORAGE_PATH, V.WRONG_DATA_FORMAT),
    ],
    [
      'ad / içerir',
      { originalName: 'a/b.pdf' },
      'originalName',
      msg(P.ORIGINAL_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'MIME desteklenmiyor',
      { mimeType: 'image/gif' },
      'mimeType',
      msg(P.MIME_TYPE, V.NOT_VALID),
    ],
    ['boyut 0', { sizeBytes: 0 }, 'sizeBytes', msg(P.SIZE_BYTES, V.MIN, 1)],
    [
      'sha256 büyük harf',
      { sha256: 'A'.repeat(64) },
      'sha256',
      msg(P.SHA256, V.WRONG_DATA_FORMAT),
    ],
    ['sha256 boş', { sha256: '' }, 'sha256', msg(P.SHA256, V.NOT_EMPTY)],
    ['petId boş', { petId: '' }, 'petId', msg(P.PET_ID, V.NOT_EMPTY)],
  ])('%s → hata', (_n, o, field, expected) =>
    expect(check(o)).toEqual({ [field]: expected }),
  );
});
