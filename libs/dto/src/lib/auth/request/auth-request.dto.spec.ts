import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { auth } from '@libs/proto';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg } from '../../../testing/first-error';
import { LoginRequestDto } from './login.dto';
import { LogoutRequestDto } from './logout.dto';
import { RefreshTokenRequestDto } from './refresh-token.dto';
import { RegisterRequestDto } from './register.dto';

describe('RegisterRequestDto', () => {
  const valid = {
    email: 'ali@example.com',
    password: 'Abcdef1!',
    fullName: 'Ali Veli',
    phone: '5551234567',
    clientType: auth.ClientType.WEB,
  };
  const check = (o: object) =>
    firstErrors(RegisterRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it('MOBILE clientType da kabul edilir', () =>
    expect(check({ clientType: auth.ClientType.MOBILE })).toEqual({}));

  it.each([
    ['email yok', { email: undefined }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    ['email boş', { email: '' }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    [
      'email çok uzun',
      { email: `${'a'.repeat(250)}@x.co` },
      'email',
      msg(P.EMAIL, V.MAX_LENGTH, 254),
    ],
    [
      'email formatı',
      { email: 'ali@' },
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
      'password boş',
      { password: '' },
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
    [
      'fullName yok',
      { fullName: undefined },
      'fullName',
      msg(P.NAME, V.NOT_EMPTY),
    ],
    [
      'fullName boşluk',
      { fullName: '   ' },
      'fullName',
      msg(P.NAME, V.NOT_EMPTY),
    ],
    [
      'fullName sayı',
      { fullName: 42 },
      'fullName',
      msg(P.NAME, V.MUST_BE_STRING),
    ],
    [
      'fullName kısa',
      { fullName: 'Al B' },
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
      'fullName tek kelime',
      { fullName: 'Ahmet' },
      'fullName',
      msg(P.NAME, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone yok',
      { phone: undefined },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
    [
      'phone sabit hat',
      { phone: '02121234567' },
      'phone',
      msg(P.PHONE, V.WRONG_DATA_FORMAT),
    ],
    [
      'clientType yok',
      { clientType: undefined },
      'clientType',
      msg(P.CLIENT_TYPE, V.WRONG_DATA_FORMAT),
    ],
    [
      'clientType UNSPECIFIED',
      { clientType: 0 },
      'clientType',
      msg(P.CLIENT_TYPE, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_name, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

describe('RegisterRequestDto normalizasyon', () => {
  const build = (o: object) =>
    plainToInstance(RegisterRequestDto, {
      email: 'ali@example.com',
      password: 'Abcdef1!',
      fullName: 'Ali Veli',
      phone: '5551234567',
      clientType: auth.ClientType.WEB,
      ...o,
    });

  it('email küçük harfe çevrilir ve kırpılır', () => {
    expect(build({ email: '  Ali@Example.COM ' }).email).toBe(
      'ali@example.com',
    );
  });

  it('fullName fazla boşluklardan arındırılır', () => {
    expect(build({ fullName: '  Ali   Veli ' }).fullName).toBe('Ali Veli');
  });

  it.each([
    ['5551234567'],
    ['05551234567'],
    ['+905551234567'],
    ['0555 123 45 67'],
  ])('%s telefonu E.164 formatina cevrilir', (phone) => {
    expect(build({ phone }).phone).toBe('+905551234567');
  });

  it.each([
    ['5551234567'],
    ['05551234567'],
    ['+905551234567'],
    ['0555 123 45 67'],
  ])('%s telefonu dogrulamadan gecer', (phone) => {
    expect(firstErrors(RegisterRequestDto, { ...build({}), phone })).toEqual(
      {},
    );
  });
});

describe('RegisterRequestDto rememberMe tasimaz', () => {
  const valid = {
    email: 'ali@example.com',
    password: 'Abcdef1!',
    fullName: 'Ali Veli',
    phone: '5551234567',
    clientType: auth.ClientType.WEB,
  };

  it.each([true, false, 'evet', 1])(
    'rememberMe %p gonderilse de yok sayilir',
    (rememberMe) => {
      expect(firstErrors(RegisterRequestDto, { ...valid, rememberMe })).toEqual(
        {},
      );
    },
  );
});

describe('LoginRequestDto', () => {
  const valid = {
    email: 'ali@example.com',
    password: 'x',
    clientType: auth.ClientType.MOBILE,
  };
  const check = (o: object) => firstErrors(LoginRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it('WEB clientType da kabul edilir', () =>
    expect(check({ clientType: auth.ClientType.WEB })).toEqual({}));

  it.each([
    ['email yok', { email: undefined }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
    ['email boş', { email: '' }, 'email', msg(P.EMAIL, V.NOT_EMPTY)],
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
      'password yok',
      { password: undefined },
      'password',
      msg(P.PASSWORD, V.NOT_EMPTY),
    ],
    [
      'password boş',
      { password: '' },
      'password',
      msg(P.PASSWORD, V.NOT_EMPTY),
    ],
    [
      'password sayı',
      { password: 5 },
      'password',
      msg(P.PASSWORD, V.MUST_BE_STRING),
    ],
    [
      'password uzun',
      { password: 'a'.repeat(73) },
      'password',
      msg(P.PASSWORD, V.MAX_LENGTH, 72),
    ],
    [
      'clientType yok',
      { clientType: undefined },
      'clientType',
      msg(P.CLIENT_TYPE, V.WRONG_DATA_FORMAT),
    ],
    [
      'clientType UNSPECIFIED',
      { clientType: 0 },
      'clientType',
      msg(P.CLIENT_TYPE, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_name, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

describe('LoginRequestDto rememberMe', () => {
  const valid = {
    email: 'ali@example.com',
    password: 'x',
    clientType: auth.ClientType.WEB,
  };
  const check = (rememberMe: unknown) =>
    firstErrors(LoginRequestDto, { ...valid, rememberMe });

  it.each([true, false])('%p kabul edilir', (rememberMe) =>
    expect(check(rememberMe)).toEqual({}),
  );

  it('gönderilmezse hata vermez', () =>
    expect(firstErrors(LoginRequestDto, valid)).toEqual({}));

  it('null, IsOptional tarafindan gonderilmemis sayilir', () =>
    expect(check(null)).toEqual({}));

  it.each(['true', 'false', 1, 0, 'evet', []])('%p reddedilir', (value) =>
    expect(check(value)).toEqual({
      rememberMe: msg(P.REMEMBER_ME, V.WRONG_DATA_TYPE),
    }),
  );
});

describe('LoginRequestDto normalizasyon', () => {
  const build = (email: string) =>
    plainToInstance(LoginRequestDto, {
      email,
      password: 'x',
      clientType: auth.ClientType.WEB,
    });

  it('email küçük harfe çevrilir ve kırpılır', () => {
    expect(build('  Ali@Example.COM ').email).toBe('ali@example.com');
  });

  it('register ile aynı normalizasyonu uygular', () => {
    const login = build('  Ali@Example.COM ');
    const register = plainToInstance(RegisterRequestDto, {
      email: '  Ali@Example.COM ',
      password: 'Abcdef1!',
      fullName: 'Ali Veli',
      phone: '5551234567',
      clientType: auth.ClientType.WEB,
    });

    expect(login.email).toBe(register.email);
  });
});

describe.each([
  ['LogoutRequestDto', LogoutRequestDto],
  ['RefreshTokenRequestDto', RefreshTokenRequestDto],
])('%s', (_name, cls) => {
  const check = (o: object) => firstErrors(cls, { refreshToken: 'tok', ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['yok', { refreshToken: undefined }, msg(P.REFRESH_TOKEN, V.NOT_EMPTY)],
    ['boş', { refreshToken: '' }, msg(P.REFRESH_TOKEN, V.NOT_EMPTY)],
    ['sayı', { refreshToken: 7 }, msg(P.REFRESH_TOKEN, V.MUST_BE_STRING)],
    [
      'uzun',
      { refreshToken: 'a'.repeat(513) },
      msg(P.REFRESH_TOKEN, V.MAX_LENGTH, 512),
    ],
  ])('refreshToken %s', (_n, override, expected) => {
    expect(check(override)).toEqual({ refreshToken: expected });
  });
});
