import {
  DtoPrefix as P,
  PET_BREEDS,
  PET_SPECIES,
  ResponseMessages,
  ValidationType as V,
} from '@libs/common';
import { pets } from '@libs/proto';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A } from '../../../testing/first-error';
import { CreatePetRequestDto } from './create-pet.dto';
import { GetPetOwnerRequestDto } from './get-pet-owner.dto';
import { GetPetRequestDto } from './get-pet.dto';
import { SearchClinicPetsRequestDto } from './search-clinic-pets.dto';
import { UpdatePetRequestDto } from './update-pet.dto';

const CHIP = '900123456789012';

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

// ---Amaç: tür ve cins listesinin kurallarını sabitlemek ---
describe('PET_BREEDS listesi', () => {
  it.each([...PET_SPECIES])(
    '%s türünün listesi tanımlıdır ve MIXED içerir',
    (species) => {
      expect(PET_BREEDS[species]).toContain('MIXED');
    },
  );

  it('her türde MIXED hariç en fazla 8 cins vardır', () => {
    Object.values(PET_BREEDS).forEach((breeds) =>
      expect(
        (breeds as readonly string[]).filter((breed) => breed !== 'MIXED')
          .length,
      ).toBeLessThanOrEqual(8),
    );
  });
});

// ---Amaç: CreatePet alan kurallarını ve normalizasyonunu doğrulamak ---
describe('CreatePetRequestDto', () => {
  const valid = {
    name: 'Boncuk',
    species: 'DOG',
    breed: 'GOLDEN_RETRIEVER',
    sex: pets.PetSex.FEMALE,
    birthDate: '2022-05-10',
    isNeutered: true,
    chipNumber: CHIP,
    ownerUserId: UUID_A,
  };
  const check = (o: object) =>
    firstErrors(CreatePetRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it('gateway gibi boş değerler gönderen istek geçerlidir', () =>
    expect(check({ birthDate: '', chipNumber: '', isNeutered: false })).toEqual(
      {},
    ));

  it('opsiyonel alanlar hiç gönderilmese de geçerlidir', () =>
    expect(
      check({
        birthDate: undefined,
        chipNumber: undefined,
        isNeutered: undefined,
        isBirthDateEstimated: undefined,
      }),
    ).toEqual({}));

  it('ad boşlukları tekleşir, çipteki boşluklar silinir, cins kodu kırpılır', () => {
    const dto = plainToInstance(CreatePetRequestDto, {
      ...valid,
      name: '  Pamuk   Kar ',
      chipNumber: '900 1234 5678 9012',
      breed: ' KANGAL ',
    });

    expect(dto.name).toBe('Pamuk Kar');
    expect(dto.chipNumber).toBe(CHIP);
    expect(dto.breed).toBe('KANGAL');
  });

  it('boş doğum tarihi ve boş çip servise undefined olarak gider', () => {
    const dto = plainToInstance(CreatePetRequestDto, {
      ...valid,
      birthDate: '',
      chipNumber: '   ',
    });

    expect(dto.birthDate).toBeUndefined();
    expect(dto.chipNumber).toBeUndefined();
  });

  it.each(['Çakıl Şeker', 'Işık', 'İnci', 'a'.repeat(32)])(
    'ad "%s" kabul edilir',
    (name) => expect(check({ name })).toEqual({}),
  );

  it('bugün doğmuş (Türkiye saati) kabul edilir', () =>
    expect(check({ birthDate: istanbulToday() })).toEqual({}));

  it('tahmini doğum tarihi tarihle birlikte kabul edilir', () =>
    expect(
      check({ isBirthDateEstimated: true, birthDate: '2023-01-01' }),
    ).toEqual({}));

  it('tahmini değil ve tarih yok kabul edilir', () =>
    expect(check({ isBirthDateEstimated: false, birthDate: '' })).toEqual({}));

  it.each([
    ['tarih gönderilmedi', { birthDate: undefined }],
    ['tarih boş (gateway)', { birthDate: '' }],
  ])('tahmini doğum tarihi ama %s → BIRTH_DATE_NOT_EMPTY', (_n, override) =>
    expect(check({ isBirthDateEstimated: true, ...override })).toEqual({
      isBirthDateEstimated: msg(P.BIRTH_DATE, V.NOT_EMPTY),
    }),
  );

  it.each([...PET_SPECIES])('%s türü MIXED cinsiyle kabul edilir', (species) =>
    expect(check({ species, breed: 'MIXED' })).toEqual({}),
  );

  it.each(
    Object.entries(PET_BREEDS).flatMap(([species, breeds]) =>
      (breeds as readonly string[]).map((breed) => [species, breed]),
    ),
  )('%s için %s kabul edilir', (species, breed) =>
    expect(check({ species, breed })).toEqual({}),
  );

  it.each([
    ['gönderilmedi', undefined],
    ['boş (gateway)', ''],
    ['yalnızca boşluk', '   '],
  ])('cins zorunludur: %s → BREED_NOT_EMPTY', (_n, breed) =>
    expect(check({ breed })).toEqual({ breed: msg(P.BREED, V.NOT_EMPTY) }),
  );

  it.each([
    ['köpeğe kuş cinsi', { species: 'DOG', breed: 'CANARY' }],
    ['gelinciğe köpek cinsi', { species: 'FERRET', breed: 'GOLDEN_RETRIEVER' }],
    ['listede olmayan cins', { breed: 'BULLDOG' }],
    ['kod yerine düz yazı', { breed: 'Golden Retriever' }],
    ['küçük harfli kod', { breed: 'golden_retriever' }],
  ])('%s → BREED_NOT_VALID', (_n, override) =>
    expect(check(override)).toEqual({ breed: msg(P.BREED, V.NOT_VALID) }),
  );

  it('tür geçersizse yalnızca tür hatası döner', () =>
    expect(check({ species: 'LION', breed: 'GOLDEN_RETRIEVER' })).toEqual({
      species: msg(P.SPECIES, V.NOT_VALID),
    }));

  it.each([
    ['name yok', { name: undefined }, 'name', msg(P.PET_NAME, V.NOT_EMPTY)],
    [
      'name yalnızca boşluk',
      { name: '   ' },
      'name',
      msg(P.PET_NAME, V.NOT_EMPTY),
    ],
    ['name sayı', { name: 5 }, 'name', msg(P.PET_NAME, V.MUST_BE_STRING)],
    [
      'name 33 harf',
      { name: 'a'.repeat(33) },
      'name',
      msg(P.PET_NAME, V.MAX_LENGTH, 32),
    ],
    [
      'name rakam içeriyor',
      { name: 'Max2' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name emoji içeriyor',
      { name: 'Boncuk 🐶' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name tire içeriyor',
      { name: 'Shih-Tzu' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name kesme içeriyor',
      { name: "D'Artagnan" },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name alt çizgi içeriyor',
      { name: 'Kara_Bas' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'name artı içeriyor',
      { name: 'Kara+Bas' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'species yok',
      { species: undefined },
      'species',
      msg(P.SPECIES, V.NOT_EMPTY),
    ],
    [
      'species listede yok',
      { species: 'LION' },
      'species',
      msg(P.SPECIES, V.NOT_VALID),
    ],
    [
      'species küçük harf',
      { species: 'dog' },
      'species',
      msg(P.SPECIES, V.NOT_VALID),
    ],
    ['breed sayı', { breed: 7 }, 'breed', msg(P.BREED, V.MUST_BE_STRING)],
    [
      'sex UNSPECIFIED',
      { sex: pets.PetSex.PET_SEX_UNSPECIFIED },
      'sex',
      msg(P.SEX, V.WRONG_DATA_FORMAT),
    ],
    ['sex yok', { sex: undefined }, 'sex', msg(P.SEX, V.WRONG_DATA_FORMAT)],
    [
      'birthDate saatli',
      { birthDate: '2022-05-10T00:00:00Z' },
      'birthDate',
      msg(P.BIRTH_DATE, V.MUST_BE_DATE),
    ],
    [
      'birthDate takvimde yok',
      { birthDate: '2022-02-30' },
      'birthDate',
      msg(P.BIRTH_DATE, V.MUST_BE_DATE),
    ],
    [
      'birthDate bozuk',
      { birthDate: 'dün' },
      'birthDate',
      msg(P.BIRTH_DATE, V.MUST_BE_DATE),
    ],
    [
      'birthDate yarın (Türkiye saati)',
      { birthDate: shiftDays(istanbulToday(), 1) },
      'birthDate',
      msg(P.BIRTH_DATE, V.CANNOT_BE_FUTURE),
    ],
    [
      'isBirthDateEstimated string',
      { isBirthDateEstimated: 'true' },
      'isBirthDateEstimated',
      msg(P.IS_BIRTH_DATE_ESTIMATED, V.MUST_BE_BOOLEAN),
    ],
    [
      'isNeutered string',
      { isNeutered: 'true' },
      'isNeutered',
      msg(P.IS_NEUTERED, V.MUST_BE_BOOLEAN),
    ],
    [
      'chip 14 hane',
      { chipNumber: CHIP.slice(1) },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'chip harf içeriyor',
      { chipNumber: '90012345678901A' },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'chip 10 haneli eski tip',
      { chipNumber: '0123456789' },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'ownerUserId yok',
      { ownerUserId: undefined },
      'ownerUserId',
      msg(P.OWNER_USER_ID, V.NOT_EMPTY),
    ],
    [
      'ownerUserId bozuk',
      { ownerUserId: 'abc' },
      'ownerUserId',
      msg(P.OWNER_USER_ID, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

// ---Amaç: UpdatePet'te en az bir alanın zorunlu olduğunu ve gönderilen alanların boş olamayacağını doğrulamak ---
describe('UpdatePetRequestDto', () => {
  const check = (o: object) =>
    firstErrors(UpdatePetRequestDto, { id: UUID_A, ...o });

  it('yalnızca id → BAD_REQUEST', () =>
    expect(check({})).toEqual({ id: ResponseMessages.BAD_REQUEST }));

  it('bütün alanlar null → BAD_REQUEST', () =>
    expect(
      check({
        name: null,
        breed: null,
        birthDate: null,
        isBirthDateEstimated: null,
        isNeutered: null,
        chipNumber: null,
      }),
    ).toEqual({ id: ResponseMessages.BAD_REQUEST }));

  it('id bozuk ve alan yok → önce id biçim hatası', () =>
    expect(check({ id: 'abc' })).toEqual({
      id: msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    }));

  it('yalnızca isNeutered=false geçerli bir güncellemedir', () =>
    expect(check({ isNeutered: false })).toEqual({}));

  it('yalnızca isBirthDateEstimated geçerli bir güncellemedir', () =>
    expect(check({ isBirthDateEstimated: true })).toEqual({}));

  it('tüm alanlar geçerli', () =>
    expect(
      check({
        name: 'Pamuk',
        breed: 'TURKISH_VAN',
        birthDate: '2021-01-01',
        isBirthDateEstimated: false,
        isNeutered: false,
        chipNumber: CHIP,
      }),
    ).toEqual({}));

  it.each(['CANARY', 'KANGAL', 'MIXED'])(
    'herhangi bir listedeki cins (%s) kabul edilir; tür uyumunu servis denetler',
    (breed) => expect(check({ breed })).toEqual({}),
  );

  it.each(['BULLDOG', 'Van Kedisi'])(
    'hiçbir listede olmayan cins (%s) → BREED_NOT_VALID',
    (breed) =>
      expect(check({ breed })).toEqual({ breed: msg(P.BREED, V.NOT_VALID) }),
  );

  it.each([
    ['id yok', { id: undefined }, 'id', msg(P.PET_ID, V.NOT_EMPTY)],
    ['id bozuk', { id: 'abc' }, 'id', msg(P.PET_ID, V.WRONG_DATA_FORMAT)],
    [
      'name boş (silinemez)',
      { name: '' },
      'name',
      msg(P.PET_NAME, V.NOT_EMPTY),
    ],
    [
      'breed boş (silinemez)',
      { breed: '' },
      'breed',
      msg(P.BREED, V.NOT_EMPTY),
    ],
    [
      'birthDate boş (silinemez)',
      { birthDate: '' },
      'birthDate',
      msg(P.BIRTH_DATE, V.NOT_EMPTY),
    ],
    [
      'chip boş (silinemez)',
      { chipNumber: '' },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.NOT_EMPTY),
    ],
    [
      'name rakam içeriyor',
      { name: 'Max2' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'birthDate gelecekte',
      { birthDate: shiftDays(istanbulToday(), 30) },
      'birthDate',
      msg(P.BIRTH_DATE, V.CANNOT_BE_FUTURE),
    ],
    [
      'isBirthDateEstimated string',
      { isBirthDateEstimated: 'x' },
      'isBirthDateEstimated',
      msg(P.IS_BIRTH_DATE_ESTIMATED, V.MUST_BE_BOOLEAN),
    ],
    [
      'isNeutered sayı',
      { isNeutered: 1 },
      'isNeutered',
      msg(P.IS_NEUTERED, V.MUST_BE_BOOLEAN),
    ],
    [
      'chip 16 hane',
      { chipNumber: `${CHIP}1` },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

// ---Amaç: klinik aramasında tek arama terimi, filtre, sıralama ve sayfalama kurallarını doğrulamak ---
describe('SearchClinicPetsRequestDto', () => {
  const base = { page: 1, pageSize: 16 };
  const check = (o: object) =>
    firstErrors(SearchClinicPetsRequestDto, { ...base, ...o });

  it('arama terimi yok → geçerli (rızalı tüm hayvanlar listelenir)', () =>
    expect(check({})).toEqual({}));

  it('boş ad ve boş çip (gateway) yok sayılır, servise undefined gider', () => {
    expect(check({ name: '', chipNumber: '' })).toEqual({});

    const dto = plainToInstance(SearchClinicPetsRequestDto, {
      ...base,
      name: '  ',
      chipNumber: '',
    });
    expect(dto.name).toBeUndefined();
    expect(dto.chipNumber).toBeUndefined();
  });

  it('ad ile arama geçerli, boşluklar tekleşir', () => {
    expect(check({ name: 'Boncuk' })).toEqual({});
    expect(
      plainToInstance(SearchClinicPetsRequestDto, {
        ...base,
        name: '  Bon   cuk ',
      }).name,
    ).toBe('Bon cuk');
  });

  it('çip ile arama geçerli, boşluklar silinir', () => {
    expect(check({ chipNumber: CHIP })).toEqual({});
    expect(
      plainToInstance(SearchClinicPetsRequestDto, {
        ...base,
        chipNumber: '900 123 456 789 012',
      }).chipNumber,
    ).toBe(CHIP);
  });

  it('tür filtresi geçerli, boş tür yok sayılır', () => {
    expect(check({ species: 'CAT' })).toEqual({});
    expect(check({ species: '' })).toEqual({});
  });

  it('ad ve çip birlikte → BAD_REQUEST', () =>
    expect(check({ name: 'Boncuk', chipNumber: CHIP })).toEqual({
      name: ResponseMessages.BAD_REQUEST,
    }));

  it.each([8, 16, 32, 64, 128])('pageSize %p kabul edilir', (pageSize) =>
    expect(check({ pageSize })).toEqual({}),
  );

  it.each([
    [
      'ad rakam içeriyor',
      { name: 'Max2' },
      'name',
      msg(P.PET_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'ad 33 karakter',
      { name: 'a'.repeat(33) },
      'name',
      msg(P.PET_NAME, V.MAX_LENGTH, 32),
    ],
    [
      'çip 14 hane',
      { chipNumber: CHIP.slice(1) },
      'chipNumber',
      msg(P.CHIP_NUMBER, V.WRONG_DATA_FORMAT),
    ],
    [
      'tür listede yok',
      { species: 'LION' },
      'species',
      msg(P.SPECIES, V.NOT_VALID),
    ],
    [
      'pageSize 10',
      { pageSize: 10 },
      'pageSize',
      msg(P.PAGE_SIZE, V.NOT_VALID),
    ],
    ['page 0', { page: 0 }, 'page', msg(P.PAGE, V.MIN, 1)],
    ['page ondalıklı', { page: 1.5 }, 'page', msg(P.PAGE, V.MUST_BE_NUMBER)],
    ['page yok', { page: undefined }, 'page', msg(P.PAGE, V.MUST_BE_NUMBER)],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });

  it.each(['asc', 'desc'])('orderFilter %s kabul edilir', (orderFilter) =>
    expect(check({ orderFilter })).toEqual({}),
  );

  it('orderFilter boş (gateway) yok sayılır', () => {
    expect(check({ orderFilter: '' })).toEqual({});
    expect(
      plainToInstance(SearchClinicPetsRequestDto, { ...base, orderFilter: '' })
        .orderFilter,
    ).toBeUndefined();
  });

  it.each(['ASC', 'Desc', 'newest', 'createdAt'])(
    'orderFilter %s → ORDER_FILTER_NOT_VALID',
    (orderFilter) =>
      expect(check({ orderFilter })).toEqual({
        orderFilter: msg(P.ORDER_FILTER, V.NOT_VALID),
      }),
  );
});

// ---Amaç: yalnızca pet id'si taşıyan isteklerin UUID kuralını doğrulamak ---
describe('tek kurallı pet id alanları', () => {
  const cases: [string, new () => object, string][] = [
    ['GetPetRequestDto', GetPetRequestDto, 'id'],
    ['GetPetOwnerRequestDto', GetPetOwnerRequestDto, 'petId'],
  ];

  it.each(cases)('%s', (_n, dto, field) => {
    expect(firstErrors(dto, { [field]: UUID_A })).toEqual({});
    expect(firstErrors(dto, {})).toEqual({
      [field]: msg(P.PET_ID, V.NOT_EMPTY),
    });
    expect(firstErrors(dto, { [field]: 'abc' })).toEqual({
      [field]: msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    });
    expect(
      firstErrors(dto, { [field]: '3f1c2b4a-8d6e-1f7a-9b0c-1d2e3f4a5b6c' }),
    ).toEqual({ [field]: msg(P.PET_ID, V.WRONG_DATA_FORMAT) });
  });
});
