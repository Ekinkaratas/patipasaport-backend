import {
  DtoPrefix as P,
  PET_RESULT_MAX_SIZE_BYTES,
  STOCK_CATEGORIES,
  STOCK_UNITS,
  ValidationType as V,
} from '@libs/common';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { AddStockItemRequestDto } from './add-stock-item.dto';
import { CreateClinicRequestDto } from './create-clinic.dto';
import { DeactivateClinicRequestDto } from './deactivate-clinic.dto';
import { GetClinicPetOverviewRequestDto } from './get-clinic-pet-overview.dto';
import { GetClinicRequestDto } from './get-clinic.dto';
import { ListStockItemsRequestDto } from './list-stock-items.dto';
import { UploadPetResultRequestDto } from './upload-pet-result.dto';

const FILE_UUID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const UUID_V1 = '3f1c2b4a-8d6e-1f7a-9b0c-1d2e3f4a5b6c';

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

// ---Amaç: stok kalemi ekleme isteğinin ad, kod listesi, miktar, kuruş cinsinden fiyat ve son kullanma tarihi kurallarını doğrulamak ---
describe('AddStockItemRequestDto', () => {
  const valid = {
    clinicId: UUID_A,
    name: 'Amoksisilin 250 mg',
    category: 'MEDICINE',
    unit: 'BOX',
    quantity: 10,
    criticalLevel: 2,
    expiresAt: shiftDays(istanbulToday(), 30),
    purchasePrice: 8_000,
    salePrice: 12_000,
  };
  const check = (o: object) =>
    firstErrors(AddStockItemRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['boş (gateway)', ''],
    ['gönderilmedi', undefined],
    ['yalnızca boşluk', '   '],
  ])('expiresAt %s → opsiyonel, kabul edilir', (_n, expiresAt) => {
    expect(check({ expiresAt })).toEqual({});
    expect(
      plainToInstance(AddStockItemRequestDto, { ...valid, expiresAt })
        .expiresAt,
    ).toBeUndefined();
  });

  it.each([
    ['bugün', 0],
    ['yarın', 1],
  ])('expiresAt %s (Türkiye saati) kabul edilir', (_n, days) =>
    expect(check({ expiresAt: shiftDays(istanbulToday(), days) })).toEqual({}),
  );

  it('expiresAt dün → CANNOT_BE_PAST', () =>
    expect(check({ expiresAt: shiftDays(istanbulToday(), -1) })).toEqual({
      expiresAt: msg(P.EXPIRES_AT, V.CANNOT_BE_PAST),
    }));

  it.each([
    '2027-13-01',
    '2027-02-30',
    '2027-01-01T10:00:00Z',
    '01.01.2027',
    '2027/01/01',
  ])('expiresAt %s → MUST_BE_DATE', (expiresAt) =>
    expect(check({ expiresAt })).toEqual({
      expiresAt: msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    }),
  );

  it('expiresAt kenar boşlukları kırpılır', () => {
    const date = shiftDays(istanbulToday(), 5);
    expect(
      plainToInstance(AddStockItemRequestDto, {
        ...valid,
        expiresAt: ` ${date} `,
      }).expiresAt,
    ).toBe(date);
  });

  it('ad boşlukları tekleşir', () =>
    expect(
      plainToInstance(AddStockItemRequestDto, {
        ...valid,
        name: '  Amoksisilin   250  mg ',
      }).name,
    ).toBe('Amoksisilin 250 mg'));

  it.each([
    'Serum %0,9 NaCl',
    'Kuduz Aşısı (Rabisin)',
    'Enjektör 2,5 ml',
    'B12+Folik Asit',
    'Gazlı Bez 10x10',
    'İğne/Uç 21G',
    'Çiğdem-ŞÖÜĞ ıiİI',
    'a'.repeat(64),
  ])('ad "%s" kabul edilir', (name) => expect(check({ name })).toEqual({}));

  it.each([
    ['boş', ''],
    ['yalnızca boşluk', '   '],
    ['gönderilmedi', undefined],
  ])('ad %s → STOCK_NAME_NOT_EMPTY', (_n, name) =>
    expect(check({ name })).toEqual({
      name: msg(P.STOCK_NAME, V.NOT_EMPTY),
    }),
  );

  it('ad 65 karakter → STOCK_NAME_MAX_LENGTH|64', () =>
    expect(check({ name: 'a'.repeat(65) })).toEqual({
      name: msg(P.STOCK_NAME, V.MAX_LENGTH, 64),
    }));

  it.each([
    'Aşı!',
    'Aşı_1',
    "Aşı's",
    'Aşı 😀',
    'Aşı#2',
    'Aşı;DROP',
    '<script>',
  ])('ad "%s" → STOCK_NAME_WRONG_DATA_FORMAT', (name) =>
    expect(check({ name })).toEqual({
      name: msg(P.STOCK_NAME, V.WRONG_DATA_FORMAT),
    }),
  );

  it('ad sayı → STOCK_NAME_MUST_BE_STRING', () =>
    expect(check({ name: 123 })).toEqual({
      name: msg(P.STOCK_NAME, V.MUST_BE_STRING),
    }));

  it.each([...STOCK_CATEGORIES])('category %s kabul edilir', (category) =>
    expect(check({ category })).toEqual({}),
  );

  it.each(['vaccine', 'aşı', 'DRUG'])(
    'category %s → CATEGORY_NOT_VALID',
    (category) =>
      expect(check({ category })).toEqual({
        category: msg(P.CATEGORY, V.NOT_VALID),
      }),
  );

  it.each([
    ['boş', ''],
    ['gönderilmedi', undefined],
  ])('category %s → CATEGORY_NOT_EMPTY', (_n, category) =>
    expect(check({ category })).toEqual({
      category: msg(P.CATEGORY, V.NOT_EMPTY),
    }),
  );

  it.each([...STOCK_UNITS])('unit %s kabul edilir', (unit) =>
    expect(check({ unit })).toEqual({}),
  );

  it.each(['adet', 'ml', 'LITRE'])('unit %s → UNIT_NOT_VALID', (unit) =>
    expect(check({ unit })).toEqual({ unit: msg(P.UNIT, V.NOT_VALID) }),
  );

  it.each([
    ['boş', ''],
    ['gönderilmedi', undefined],
  ])('unit %s → UNIT_NOT_EMPTY', (_n, unit) =>
    expect(check({ unit })).toEqual({ unit: msg(P.UNIT, V.NOT_EMPTY) }),
  );

  describe.each([
    ['quantity', P.QUANTITY],
    ['criticalLevel', P.CRITICAL_LEVEL],
  ])('%s', (field, prefix) => {
    it.each([0, 1, 100_000])('%p kabul edilir', (value) =>
      expect(check({ [field]: value })).toEqual({}),
    );

    it('-1 → MIN|0', () =>
      expect(check({ [field]: -1 })).toEqual({
        [field]: msg(prefix, V.MIN, 0),
      }));

    it('100001 → MAX|100000', () =>
      expect(check({ [field]: 100_001 })).toEqual({
        [field]: msg(prefix, V.MAX, 100_000),
      }));

    it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      '%p → MUST_BE_NUMBER',
      (value) =>
        expect(check({ [field]: value })).toEqual({
          [field]: msg(prefix, V.MUST_BE_NUMBER),
        }),
    );
  });

  describe.each([
    ['purchasePrice', P.PURCHASE_PRICE],
    ['salePrice', P.SALE_PRICE],
  ])('%s (kuruş)', (field, prefix) => {
    it.each([0, 1, 1_000_000_000])('%p kabul edilir', (value) =>
      expect(check({ [field]: value })).toEqual({}),
    );

    it('sayısal metin sayıya dönüşür', () =>
      expect(
        plainToInstance(AddStockItemRequestDto, { ...valid, [field]: '14990' })[
          field as 'purchasePrice' | 'salePrice'
        ],
      ).toBe(14_990));

    it('-1 → MIN|0', () =>
      expect(check({ [field]: -1 })).toEqual({
        [field]: msg(prefix, V.MIN, 0),
      }));

    it('1000000001 → MAX|1000000000', () =>
      expect(check({ [field]: 1_000_000_001 })).toEqual({
        [field]: msg(prefix, V.MAX, 1_000_000_000),
      }));

    it.each([undefined, null, '', '   ', true, 149.9, 'fiyat', Number.NaN])(
      '%p → MUST_BE_NUMBER',
      (value) =>
        expect(check({ [field]: value })).toEqual({
          [field]: msg(prefix, V.MUST_BE_NUMBER),
        }),
    );
  });

  it.each([
    ['yok', undefined, msg(P.CLINIC_ID, V.NOT_EMPTY)],
    ['bozuk', 'abc', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('clinicId %s', (_n, clinicId, expected) =>
    expect(check({ clinicId })).toEqual({ clinicId: expected }),
  );
});

// ---Amaç: stok listesinde kategori filtresi, kritik seviye filtresi ve sayfalama kurallarını doğrulamak ---
describe('ListStockItemsRequestDto', () => {
  const valid = { clinicId: UUID_A, page: 1, pageSize: 8 };
  const check = (o: object) =>
    firstErrors(ListStockItemsRequestDto, { ...valid, ...o });

  it('yalnızca zorunlu alanlar ile geçerlidir', () =>
    expect(check({})).toEqual({}));

  it.each([...STOCK_CATEGORIES])(
    'category filtresi %s kabul edilir',
    (category) => expect(check({ category })).toEqual({}),
  );

  it('category boş (gateway) → filtre yok sayılır', () => {
    expect(check({ category: '' })).toEqual({});
    expect(
      plainToInstance(ListStockItemsRequestDto, { ...valid, category: '' })
        .category,
    ).toBeUndefined();
  });

  it.each(['aşı', 'vaccine'])('category %s → CATEGORY_NOT_VALID', (category) =>
    expect(check({ category })).toEqual({
      category: msg(P.CATEGORY, V.NOT_VALID),
    }),
  );

  it.each([true, false, undefined, 'true', 'false'])(
    'onlyBelowCritical %p kabul edilir',
    (onlyBelowCritical) => expect(check({ onlyBelowCritical })).toEqual({}),
  );

  it.each([
    ['true', true],
    ['false', false],
  ])(
    'sorgu dizesinden gelen onlyBelowCritical %p boolean %p olur',
    (raw, expected) =>
      expect(
        plainToInstance(ListStockItemsRequestDto, {
          clinicId: UUID_A,
          page: 1,
          pageSize: 8,
          onlyBelowCritical: raw,
        }).onlyBelowCritical,
      ).toBe(expected),
  );

  it.each(['evet', 'TRUE', '1', 1])(
    'onlyBelowCritical %p → ONLY_BELOW_CRITICAL_MUST_BE_BOOLEAN',
    (onlyBelowCritical) =>
      expect(check({ onlyBelowCritical })).toEqual({
        onlyBelowCritical: msg(P.ONLY_BELOW_CRITICAL, V.MUST_BE_BOOLEAN),
      }),
  );

  it.each([8, 16, 32, 64, 128])('pageSize %p kabul edilir', (pageSize) =>
    expect(check({ pageSize })).toEqual({}),
  );

  it.each([
    ['page 0', { page: 0 }, 'page', msg(P.PAGE, V.MIN, 1)],
    ['page ondalıklı', { page: 1.5 }, 'page', msg(P.PAGE, V.MUST_BE_NUMBER)],
    [
      'pageSize 10',
      { pageSize: 10 },
      'pageSize',
      msg(P.PAGE_SIZE, V.NOT_VALID),
    ],
    [
      'clinicId bozuk',
      { clinicId: 'abc' },
      'clinicId',
      msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

// ---Amaç: sonuç dosyası yükleme isteğinin dosya türü, yol, ad, boyut ve not kurallarını doğrulamak ---
describe('UploadPetResultRequestDto', () => {
  const valid = {
    clinicId: UUID_A,
    petId: UUID_B,
    storagePath: `${FILE_UUID}.pdf`,
    originalName: 'Kan Tahlili Sonucu.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    note: 'Açlık kan şekeri',
    sha256: 'a'.repeat(64),
  };
  const check = (o: object) =>
    firstErrors(UploadPetResultRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['yok', undefined, msg(P.SHA256, V.NOT_EMPTY)],
    ['boş', '', msg(P.SHA256, V.NOT_EMPTY)],
    ['sayı', 123, msg(P.SHA256, V.MUST_BE_STRING)],
    ['63 hane', 'a'.repeat(63), msg(P.SHA256, V.WRONG_DATA_FORMAT)],
    ['büyük harf', 'A'.repeat(64), msg(P.SHA256, V.WRONG_DATA_FORMAT)],
    ['hex dışı karakter', `${'a'.repeat(63)}g`, msg(P.SHA256, V.WRONG_DATA_FORMAT)],
  ])('sha256 %s → reddedilir', (_n, sha256, expected) =>
    expect(check({ sha256 })).toEqual({ sha256: expected }),
  );

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
  ])('%s ve .%s uzantısı kabul edilir', (mimeType, extension) =>
    expect(
      check({ mimeType, storagePath: `${FILE_UUID}.${extension}` }),
    ).toEqual({}),
  );

  it('mimeType büyük harf ve boşluktan arındırılır', () => {
    expect(check({ mimeType: ' APPLICATION/PDF ' })).toEqual({});
    expect(
      plainToInstance(UploadPetResultRequestDto, {
        ...valid,
        mimeType: ' APPLICATION/PDF ',
      }).mimeType,
    ).toBe('application/pdf');
  });

  it.each([
    'image/gif',
    'text/html',
    'application/x-msdownload',
    'image/svg+xml',
  ])('mimeType %s → MIME_TYPE_NOT_VALID', (mimeType) =>
    expect(check({ mimeType })).toEqual({
      mimeType: msg(P.MIME_TYPE, V.NOT_VALID),
    }),
  );

  it('mimeType boş → MIME_TYPE_NOT_EMPTY', () =>
    expect(check({ mimeType: '' })).toEqual({
      mimeType: msg(P.MIME_TYPE, V.NOT_EMPTY),
    }));

  it.each([
    ['application/pdf', 'png'],
    ['image/png', 'pdf'],
    ['image/jpeg', 'png'],
  ])('%s ama uzantı .%s → STORAGE_PATH_NOT_VALID', (mimeType, extension) =>
    expect(
      check({ mimeType, storagePath: `${FILE_UUID}.${extension}` }),
    ).toEqual({ storagePath: msg(P.STORAGE_PATH, V.NOT_VALID) }),
  );

  it.each([
    ['yol aşımı', '../etc/passwd'],
    ['üst klasöre çıkan ad', `../${FILE_UUID}.pdf`],
    ['mutlak yol', `/var/medical-files/${FILE_UUID}.pdf`],
    ['alt klasör', `sub/${FILE_UUID}.pdf`],
    ['ad sonrası yol', `${FILE_UUID}.pdf/../x.pdf`],
    ['null byte', `${FILE_UUID}.pdf\u0000.png`],
    ['Windows yolu', `C:\\files\\${FILE_UUID}.pdf`],
    ['büyük harfli UUID', `${FILE_UUID.toUpperCase()}.pdf`],
    ['büyük harfli uzantı', `${FILE_UUID}.PDF`],
    ['uzantısız', FILE_UUID],
    ['boş uzantı', `${FILE_UUID}.`],
    ['çift nokta', `${FILE_UUID}..pdf`],
    ['UUID v4 değil', `${UUID_V1}.pdf`],
    ['baştaki boşluk', ` ${FILE_UUID}.pdf`],
  ])('storagePath %s → STORAGE_PATH_WRONG_DATA_FORMAT', (_n, storagePath) =>
    expect(check({ storagePath })).toEqual({
      storagePath: msg(P.STORAGE_PATH, V.WRONG_DATA_FORMAT),
    }),
  );

  it('storagePath boş → STORAGE_PATH_NOT_EMPTY', () =>
    expect(check({ storagePath: '' })).toEqual({
      storagePath: msg(P.STORAGE_PATH, V.NOT_EMPTY),
    }));

  it.each([
    'Röntgen (ön-arka) 12.10.2026.jpg',
    'çok   boşluklu ad.pdf',
    'İĞÜŞÖÇ ığüşöç.png',
    'a'.repeat(255),
  ])('originalName %p kabul edilir', (originalName) =>
    expect(check({ originalName })).toEqual({}),
  );

  it('originalName kenar boşlukları kırpılır', () =>
    expect(
      plainToInstance(UploadPetResultRequestDto, {
        ...valid,
        originalName: '  x.pdf ',
      }).originalName,
    ).toBe('x.pdf'));

  it.each([
    ['eğik çizgi', 'a/b.pdf'],
    ['ters eğik çizgi', 'a\\b.pdf'],
    ['null byte', 'a\u0000b.pdf'],
    ['satır sonu', 'a\nb.pdf'],
    ['sekme', 'a\tb.pdf'],
    ['DEL karakteri', 'a\u007fb.pdf'],
  ])(
    'originalName %s içeriyor → ORIGINAL_NAME_WRONG_DATA_FORMAT',
    (_n, originalName) =>
      expect(check({ originalName })).toEqual({
        originalName: msg(P.ORIGINAL_NAME, V.WRONG_DATA_FORMAT),
      }),
  );

  it.each([
    ['boş', ''],
    ['yalnızca boşluk', '   '],
  ])('originalName %s → ORIGINAL_NAME_NOT_EMPTY', (_n, originalName) =>
    expect(check({ originalName })).toEqual({
      originalName: msg(P.ORIGINAL_NAME, V.NOT_EMPTY),
    }),
  );

  it('originalName 256 karakter → ORIGINAL_NAME_MAX_LENGTH|255', () =>
    expect(check({ originalName: 'a'.repeat(256) })).toEqual({
      originalName: msg(P.ORIGINAL_NAME, V.MAX_LENGTH, 255),
    }));

  it.each([1, PET_RESULT_MAX_SIZE_BYTES])(
    'sizeBytes %p kabul edilir',
    (sizeBytes) => expect(check({ sizeBytes })).toEqual({}),
  );

  it.each([
    ['0', 0, msg(P.SIZE_BYTES, V.MIN, 1)],
    [
      '10 MB + 1',
      PET_RESULT_MAX_SIZE_BYTES + 1,
      msg(P.SIZE_BYTES, V.MAX, PET_RESULT_MAX_SIZE_BYTES),
    ],
    ['ondalıklı', 1.5, msg(P.SIZE_BYTES, V.MUST_BE_NUMBER)],
  ])('sizeBytes %s', (_n, sizeBytes, expected) =>
    expect(check({ sizeBytes })).toEqual({ sizeBytes: expected }),
  );

  it.each([
    ['boş (gateway)', ''],
    ['gönderilmedi', undefined],
    ['yalnızca boşluk', '   '],
  ])('note %s → opsiyonel, servise undefined gider', (_n, note) => {
    expect(check({ note })).toEqual({});
    expect(
      plainToInstance(UploadPetResultRequestDto, { ...valid, note }).note,
    ).toBeUndefined();
  });

  it.each([
    'Satır 1\nSatır 2',
    'Satır 1\r\nSatır 2',
    'Doz: 2,5 ml/kg; kontrol 3 gün sonra (!)',
    'a'.repeat(500),
  ])('note %p kabul edilir', (note) => expect(check({ note })).toEqual({}));

  it.each([
    ['sekme', 'a\tb'],
    ['zil karakteri', 'a\u0007b'],
    ['null byte', 'a\u0000b'],
    ['escape karakteri', 'a\u001bb'],
  ])('note %s içeriyor → NOTE_WRONG_DATA_FORMAT', (_n, note) =>
    expect(check({ note })).toEqual({
      note: msg(P.NOTE, V.WRONG_DATA_FORMAT),
    }),
  );

  it('note 501 karakter → NOTE_MAX_LENGTH|500', () =>
    expect(check({ note: 'a'.repeat(501) })).toEqual({
      note: msg(P.NOTE, V.MAX_LENGTH, 500),
    }));

  it.each([
    [
      'clinicId bozuk',
      { clinicId: 'abc' },
      'clinicId',
      msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    ],
    ['petId yok', { petId: undefined }, 'petId', msg(P.PET_ID, V.NOT_EMPTY)],
    [
      'petId bozuk',
      { petId: 'abc' },
      'petId',
      msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

// ---Amaç: yalnızca kimlik taşıyan klinik isteklerinin UUID kurallarını doğrulamak ---
describe('tek kurallı klinik id alanları', () => {
  it('GetClinicRequestDto geçerli / yok / bozuk', () => {
    expect(firstErrors(GetClinicRequestDto, { id: UUID_A })).toEqual({});
    expect(firstErrors(GetClinicRequestDto, {})).toEqual({
      id: msg(P.CLINIC_ID, V.NOT_EMPTY),
    });
    expect(firstErrors(GetClinicRequestDto, { id: UUID_V1 })).toEqual({
      id: msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    });
  });

  it.each([
    ['geçerli', { clinicId: UUID_A, petId: UUID_B }, {}],
    [
      'clinicId yok',
      { petId: UUID_B },
      { clinicId: msg(P.CLINIC_ID, V.NOT_EMPTY) },
    ],
    [
      'petId bozuk',
      { clinicId: UUID_A, petId: 'abc' },
      { petId: msg(P.PET_ID, V.WRONG_DATA_FORMAT) },
    ],
  ])('GetClinicPetOverviewRequestDto %s', (_n, plain, expected) =>
    expect(firstErrors(GetClinicPetOverviewRequestDto, plain)).toEqual(
      expected,
    ),
  );

  it.each([
    ['geçerli', { clinicId: UUID_A }, {}],
    ['yok', {}, { clinicId: msg(P.CLINIC_ID, V.NOT_EMPTY) }],
    ['boş', { clinicId: '' }, { clinicId: msg(P.CLINIC_ID, V.NOT_EMPTY) }],
    [
      'v1 uuid',
      { clinicId: UUID_V1 },
      { clinicId: msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT) },
    ],
  ])('DeactivateClinicRequestDto %s', (_n, plain, expected) =>
    expect(firstErrors(DeactivateClinicRequestDto, plain)).toEqual(expected),
  );
});

// ---Amaç: klinik oluşturma isteğinin ad, vergi no, telefon, e-posta ve şifre kurallarını ilk hata mesajıyla doğrulamak ---
describe('CreateClinicRequestDto', () => {
  const valid = {
    name: 'Pati&Can 2 Veteriner Kliniği',
    taxNumber: '4540536920',
    phone: '+902161234567',
    email: 'klinik@example.com',
    password: 'Abcdef1!',
  };
  const check = (o: object) =>
    firstErrors(CreateClinicRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['10 haneli geçerli VKN', '4540536920'],
    ['11 haneli geçerli TCKN', '17291716060'],
  ])('taxNumber %s kabul edilir', (_n, taxNumber) =>
    expect(check({ taxNumber })).toEqual({}),
  );

  it.each([
    "Dr. Ayşe'nin Kliniği",
    'Can-Vet',
    'Şifa 24',
    'a'.repeat(64),
  ])('name "%s" kabul edilir', (name) => expect(check({ name })).toEqual({}));

  it.each([
    ['name yok', { name: undefined }, 'name', msg(P.CLINIC_NAME, V.NOT_EMPTY)],
    ['name sayı', { name: 5 }, 'name', msg(P.CLINIC_NAME, V.MUST_BE_STRING)],
    ['name kısa', { name: 'A' }, 'name', msg(P.CLINIC_NAME, V.MIN_LENGTH, 2)],
    [
      'name uzun',
      { name: 'a'.repeat(65) },
      'name',
      msg(P.CLINIC_NAME, V.MAX_LENGTH, 64),
    ],
    [
      'name izinsiz karakter',
      { name: 'Pati_Klinik' },
      'name',
      msg(P.CLINIC_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name yalnız işaret',
      { name: '--' },
      'name',
      msg(P.CLINIC_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name yalnız rakam',
      { name: '24 7' },
      'name',
      msg(P.CLINIC_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'taxNumber yok',
      { taxNumber: undefined },
      'taxNumber',
      msg(P.TAX_NUMBER, V.NOT_EMPTY),
    ],
    [
      'taxNumber sayı',
      { taxNumber: 4540536920 },
      'taxNumber',
      msg(P.TAX_NUMBER, V.MUST_BE_STRING),
    ],
    [
      'taxNumber 9 hane',
      { taxNumber: '454053692' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'taxNumber 12 hane',
      { taxNumber: '454053692012' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'taxNumber harf içeriyor',
      { taxNumber: 'X540536920' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'VKN kontrol hanesi tutmuyor',
      { taxNumber: '4540536921' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.NOT_VALID),
    ],
    [
      'TCKN kontrol haneleri tutmuyor',
      { taxNumber: '17291716050' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.NOT_VALID),
    ],
    [
      'TCKN 0 ile başlıyor',
      { taxNumber: '07291716092' },
      'taxNumber',
      msg(P.TAX_NUMBER, V.NOT_VALID),
    ],
    [
      'phone yok',
      { phone: undefined },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
    ['email yok', { email: undefined }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    [
      'email formatı',
      { email: 'klinik@' },
      'email',
      msg(P.EMAIL, V.WRONG_DATA_FORMAT),
    ],
    [
      'password yok',
      { password: undefined },
      'password',
      msg(P.PASSWORD, V.NOT_EMPTY),
    ],
    [
      'password sayı',
      { password: 12345678 },
      'password',
      msg(P.PASSWORD, V.MUST_BE_STRING),
    ],
    [
      'password kısa',
      { password: 'Ab1!' },
      'password',
      msg(P.PASSWORD, V.MIN_LENGTH, 8),
    ],
    [
      'password uzun',
      { password: `Ab1!${'a'.repeat(69)}` },
      'password',
      msg(P.PASSWORD, V.MAX_LENGTH, 72),
    ],
    [
      'password zayıf',
      { password: 'abcdefgh' },
      'password',
      msg(P.PASSWORD, V.WEAK_PASSWORD),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });

  it.each([
    ['0216 123 45 67', '+902161234567'],
    ['02161234567', '+902161234567'],
    ['2161234567', '+902161234567'],
    ['+902161234567', '+902161234567'],
    ['0312 123 45 67', '+903121234567'],
    ['0422 123 45 67', '+904221234567'],
    ['0850 123 45 67', '+908501234567'],
    ['0555 123 45 67', '+905551234567'],
  ])('phone %s -> %s', (phone, expected) => {
    expect(check({ phone })).toEqual({});
    expect(plainToInstance(CreateClinicRequestDto, { ...valid, phone }).phone).toBe(
      expected,
    );
  });

  it.each([
    '01161234567',
    '06161234567',
    '07161234567',
    '09161234567',
    '902161234567',
    '021612345',
    '(0216) 123-45-67',
  ])('phone %s reddedilir', (phone) => {
    expect(check({ phone })).toEqual({
      phone: msg(P.PHONE, V.WRONG_DATA_FORMAT),
    });
  });

  it('name tek boşluğa indirilir, email küçük harfe çevrilir', () => {
    const dto = plainToInstance(CreateClinicRequestDto, {
      ...valid,
      name: '  Pati   Can  ',
      email: ' Klinik@Example.COM ',
    });
    expect(dto).toMatchObject({ name: 'Pati Can', email: 'klinik@example.com' });
  });
});
