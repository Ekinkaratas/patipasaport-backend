import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { users } from '@libs/proto';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { CreateUserRequestDto } from './create-user.dto';
import { GetUserContactRequestDto } from './get-user-contact.dto';
import { GetUserDisplayNamesRequesDto } from './get-user-display-names.dto';
import { ListUsersByClinicRequestDto } from './list-users-by-clinic.dto';
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
      msg(P.EMAIL, V.MAX_LENGTH, 255),
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
      ['geçerli', { userId: UUID_A }, {}],
      ['yok', {}, { userId: msg(P.USER_ID, V.NOT_EMPTY) }],
      ['boş', { userId: '' }, { userId: msg(P.USER_ID, V.NOT_EMPTY) }],
      [
        'bozuk',
        { userId: 'abc' },
        { userId: msg(P.USER_ID, V.WRONG_DATA_FORMAT) },
      ],
    ])('userId %s', (_n, plain, expected) => {
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

describe('ListUsersByClinicRequestDto', () => {
  const valid = { clinicId: UUID_A, page: 1, pageSize: 16 };
  const check = (o: object) =>
    firstErrors(ListUsersByClinicRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));
  it('role opsiyonel ve geçerli değer kabul edilir', () =>
    expect(check({ role: users.UserRole.CLINIC })).toEqual({}));

  it.each([
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
    [
      'role UNSPECIFIED',
      { role: 0 },
      'role',
      msg(P.USER_ROLE, V.WRONG_DATA_FORMAT),
    ],
    [
      'kaldırılan STAFF değeri (3)',
      { role: 3 },
      'role',
      msg(P.USER_ROLE, V.WRONG_DATA_FORMAT),
    ],
    ['page yok', { page: undefined }, 'page', msg(P.PAGE, V.MUST_BE_NUMBER)],
    ['page ondalık', { page: 1.5 }, 'page', msg(P.PAGE, V.MUST_BE_NUMBER)],
    ['page sıfır', { page: 0 }, 'page', msg(P.PAGE, V.MIN, 1)],
    [
      'pageSize yok',
      { pageSize: undefined },
      'pageSize',
      msg(P.PAGE_SIZE, V.MUST_BE_NUMBER),
    ],
    [
      'pageSize listede yok',
      { pageSize: 10 },
      'pageSize',
      msg(P.PAGE_SIZE, V.NOT_VALID),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
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
