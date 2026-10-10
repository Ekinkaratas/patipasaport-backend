import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { CreateClinicUserRequestDto } from './create-clinic-user.dto';
import { CreateUserRequestDto } from './create-user.dto';
import { DeactivateClinicUsersRequestDto } from './deactivate-clinic-users.dto';
import { GetUserContactRequestDto } from './get-user-contact.dto';
import { GetUserDisplayNamesRequesDto } from './get-user-display-names.dto';
import { UpdateUserRequestDto } from './update-me.dto';

describe('CreateUserRequestDto', () => {
  const valid = {
    id: UUID_A,
    email: 'ali@example.com',
    fullName: 'Ali Veli',
    phone: '+905551234567',
  };
  const check = (o: object) =>
    firstErrors(CreateUserRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['id yok', { id: undefined }, 'id', msg(P.USER_ID, V.NOT_EMPTY)],
    ['id bozuk', { id: 'abc' }, 'id', msg(P.USER_ID, V.WRONG_DATA_FORMAT)],
    ['email yok', { email: undefined }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    [
      'email çok uzun',
      { email: `${'a'.repeat(251)}@x.co` },
      'email',
      msg(P.EMAIL, V.MAX_LENGTH, 254),
    ],
    [
      'email formatı',
      { email: 'ali' },
      'email',
      msg(P.EMAIL, V.WRONG_DATA_FORMAT),
    ],
    [
      'fullName sayı',
      { fullName: 1 },
      'fullName',
      msg(P.NAME, V.MUST_BE_STRING),
    ],
    [
      'fullName kısa',
      { fullName: 'Ali' },
      'fullName',
      msg(P.NAME, V.MIN_LENGTH, 5),
    ],
    [
      'fullName uzun',
      { fullName: `Ali ${'a'.repeat(61)}` },
      'fullName',
      msg(P.NAME, V.MAX_LENGTH, 64),
    ],
    [
      'fullName formatı',
      { fullName: 'Ali2 Veli' },
      'fullName',
      msg(P.NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone yok',
      { phone: undefined },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

describe('CreateUserRequestDto normalizasyon', () => {
  const base = {
    id: UUID_A,
    email: 'ali@example.com',
    fullName: 'Ali Veli',
    phone: '+905551234567',
  };

  it('email küçük harfe, fullName tek boşluğa indirilir', () => {
    const dto = plainToInstance(CreateUserRequestDto, {
      ...base,
      email: ' Ali@Example.com ',
      fullName: '  Ali   Veli ',
    });
    expect(dto).toMatchObject({
      email: 'ali@example.com',
      fullName: 'Ali Veli',
    });
  });

  it.each(['5551234567', '05551234567', '+905551234567', '0555 123 45 67'])(
    'phone %s -> +905551234567',
    (phone) => {
      expect(firstErrors(CreateUserRequestDto, { ...base, phone })).toEqual({});
      expect(
        plainToInstance(CreateUserRequestDto, { ...base, phone }).phone,
      ).toBe('+905551234567');
    },
  );

  it.each(['02121234567', '905551234567', '555123456'])(
    'phone %s reddedilir',
    (phone) => {
      expect(firstErrors(CreateUserRequestDto, { ...base, phone })).toEqual({
        phone: msg(P.PHONE, V.WRONG_DATA_FORMAT),
      });
    },
  );
});

describe.each([['GetUserContactRequestDto', GetUserContactRequestDto]])(
  '%s',
  (_name, cls) => {
    it.each([
      ['geçerli', { userId: UUID_A, petId: UUID_B }, {}],
      ['yok', { petId: UUID_B }, { userId: msg(P.USER_ID, V.NOT_EMPTY) }],
      [
        'boş',
        { userId: '', petId: UUID_B },
        { userId: msg(P.USER_ID, V.NOT_EMPTY) },
      ],
      [
        'bozuk',
        { userId: 'abc', petId: UUID_B },
        { userId: msg(P.USER_ID, V.WRONG_DATA_FORMAT) },
      ],
    ])('userId %s', (_n, plain, expected) => {
      expect(firstErrors(cls, plain)).toEqual(expected);
    });

    it.each([
      ['yok', { userId: UUID_A }, { petId: msg(P.PET_ID, V.NOT_EMPTY) }],
      [
        'boş',
        { userId: UUID_A, petId: '' },
        { petId: msg(P.PET_ID, V.NOT_EMPTY) },
      ],
      [
        'bozuk',
        { userId: UUID_A, petId: 'abc' },
        { petId: msg(P.PET_ID, V.WRONG_DATA_FORMAT) },
      ],
    ])('petId %s', (_n, plain, expected) => {
      expect(firstErrors(cls, plain)).toEqual(expected);
    });
  },
);

describe('GetUserDisplayNamesRequesDto', () => {
  const check = (userIds: unknown) =>
    firstErrors(GetUserDisplayNamesRequesDto, { userIds });

  it('geçerli istek hata vermez', () =>
    expect(check([UUID_A, UUID_B])).toEqual({}));
  it('tekrarlı id temizlenir, hata vermez', () =>
    expect(check([UUID_A, UUID_A])).toEqual({}));

  it.each([
    ['yok', undefined, msg(P.USER_IDS, V.MUST_BE_ARRAY)],
    ['string', UUID_A, msg(P.USER_IDS, V.MUST_BE_ARRAY)],
    ['boş dizi', [], msg(P.USER_IDS, V.MIN, 1)],
    ['bozuk id', ['abc'], msg(P.USER_IDS, V.WRONG_DATA_FORMAT)],
  ])('userIds %s', (_n, userIds, expected) => {
    expect(check(userIds)).toEqual({ userIds: expected });
  });
});

describe('CreateClinicUserRequestDto', () => {
  const valid = {
    id: UUID_A,
    email: 'klinik@example.com',
    fullName: 'Pati&Can 2 Veteriner',
    phone: '+902161234567',
    clinicId: UUID_B,
  };
  const check = (o: object) =>
    firstErrors(CreateClinicUserRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['id yok', { id: undefined }, 'id', msg(P.USER_ID, V.NOT_EMPTY)],
    ['id bozuk', { id: 'abc' }, 'id', msg(P.USER_ID, V.WRONG_DATA_FORMAT)],
    ['email yok', { email: undefined }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    [
      'email çok uzun',
      { email: `${'a'.repeat(250)}@x.co` },
      'email',
      msg(P.EMAIL, V.MAX_LENGTH, 254),
    ],
    [
      'email formatı',
      { email: 'klinik' },
      'email',
      msg(P.EMAIL, V.WRONG_DATA_FORMAT),
    ],
    [
      'fullName yok',
      { fullName: undefined },
      'fullName',
      msg(P.CLINIC_NAME, V.NOT_EMPTY),
    ],
    [
      'fullName yalnız boşluk',
      { fullName: '   ' },
      'fullName',
      msg(P.CLINIC_NAME, V.NOT_EMPTY),
    ],
    [
      'fullName sayı',
      { fullName: 1 },
      'fullName',
      msg(P.CLINIC_NAME, V.MUST_BE_STRING),
    ],
    [
      'fullName kısa',
      { fullName: 'A' },
      'fullName',
      msg(P.CLINIC_NAME, V.MIN_LENGTH, 2),
    ],
    [
      'fullName uzun',
      { fullName: 'a'.repeat(65) },
      'fullName',
      msg(P.CLINIC_NAME, V.MAX_LENGTH, 64),
    ],
    [
      'fullName izinsiz karakter',
      { fullName: 'Pati@Klinik' },
      'fullName',
      msg(P.CLINIC_NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone yok',
      { phone: undefined },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone 1 ile başlıyor',
      { phone: '+901161234567' },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
    [
      'clinicId yok',
      { clinicId: undefined },
      'clinicId',
      msg(P.CLINIC_ID, V.NOT_EMPTY),
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

  it('email küçük harfe, fullName tek boşluğa, phone E.164 biçimine çevrilir', () => {
    const dto = plainToInstance(CreateClinicUserRequestDto, {
      ...valid,
      email: ' Klinik@Example.com ',
      fullName: '  Pati   Can  ',
      phone: '0216 123 45 67',
    });
    expect(dto).toMatchObject({
      email: 'klinik@example.com',
      fullName: 'Pati Can',
      phone: '+902161234567',
    });
  });
});

describe('DeactivateClinicUsersRequestDto', () => {
  it.each([
    ['geçerli', { clinicId: UUID_A }, {}],
    ['yok', {}, { clinicId: msg(P.CLINIC_ID, V.NOT_EMPTY) }],
    ['boş', { clinicId: '' }, { clinicId: msg(P.CLINIC_ID, V.NOT_EMPTY) }],
    [
      'bozuk',
      { clinicId: 'abc' },
      { clinicId: msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT) },
    ],
  ])('clinicId %s', (_n, plain, expected) => {
    expect(firstErrors(DeactivateClinicUsersRequestDto, plain)).toEqual(
      expected,
    );
  });
});

describe('UpdateUserRequestDto', () => {
  const check = (o: object) => firstErrors(UpdateUserRequestDto, o);

  it('tüm alanlar opsiyonel', () => expect(check({})).toEqual({}));
  it('geçerli tam istek', () =>
    expect(check({ fullName: 'Ali Veli', phone: '05551234567' })).toEqual({}));
  it('phone normalize edilir, fullName tek boşluğa indirilir', () => {
    const dto = plainToInstance(UpdateUserRequestDto, {
      phone: '0555 123 45 67',
      fullName: ' Ali   Veli ',
    });
    expect(dto).toMatchObject({ phone: '+905551234567', fullName: 'Ali Veli' });
    expect(
      firstErrors(UpdateUserRequestDto, { phone: '0555 123 45 67' }),
    ).toEqual({});
  });
  it('gönderilmeyen phone undefined kalır', () =>
    expect(plainToInstance(UpdateUserRequestDto, {}).phone).toBeUndefined());

  it('adres alanları artık DTO dışında: whitelist ile atılır', () =>
    expect(check({ addressLine: 5, city: 'a', district: '!' })).toEqual({}));

  it.each([
    [
      'fullName sayı',
      { fullName: 1 },
      'fullName',
      msg(P.NAME, V.MUST_BE_STRING),
    ],
    [
      'fullName kısa',
      { fullName: 'Ali' },
      'fullName',
      msg(P.NAME, V.MIN_LENGTH, 5),
    ],
    [
      'fullName uzun',
      { fullName: `Ali ${'a'.repeat(61)}` },
      'fullName',
      msg(P.NAME, V.MAX_LENGTH, 64),
    ],
    [
      'fullName formatı',
      { fullName: 'Ali2 Veli' },
      'fullName',
      msg(P.NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone formatı',
      { phone: '02121234567' },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});
