import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { auth } from '@libs/proto';
import { firstErrors, msg, UUID_A } from '../../testing/first-error';
import { RegisterRequestDto } from '../auth/request/register.dto';
import { CreateUserRequestDto } from '../users/request/create-user.dto';
import { UpdateUserRequestDto } from '../users/request/update-me.dto';

// Register -> CreateUser zincirinde aynı isim iki DTO'dan da geçmeli;
// UpdateMe de aynı kuralı uygular. Üçü için ilk hata birebir aynı olmalı.
const nameErrorOf = {
  register: (fullName: unknown) =>
    firstErrors(RegisterRequestDto, {
      email: 'ali@example.com',
      password: 'Abcdef1!',
      fullName,
      phone: '5551234567',
      clientType: auth.ClientType.WEB,
    })['fullName'],
  createUser: (fullName: unknown) =>
    firstErrors(CreateUserRequestDto, {
      id: UUID_A,
      email: 'ali@example.com',
      fullName,
      phone: '+905551234567',
    })['fullName'],
  updateMe: (fullName: unknown) =>
    firstErrors(UpdateUserRequestDto, { fullName })['fullName'],
};

describe('FullName ortak kuralı', () => {
  it.each([
    ['Ali Veli', undefined],
    ['Âdem Yılmaz', undefined],
    ['Ali Şûra', undefined],
    ['İpek Öz-Güneş', undefined],
    ["Ali O'Neil", undefined],
    ['  Ali   Veli ', undefined],
    ['Su Ak', undefined],
    ['A B', msg(P.NAME, V.MIN_LENGTH, 5)],
    ['Al B', msg(P.NAME, V.MIN_LENGTH, 5)],
    ['Ahmetcan', msg(P.NAME, V.WRONG_DATA_FORMAT)],
    ['Ali2 Veli', msg(P.NAME, V.WRONG_DATA_FORMAT)],
    ['-Ali Veli', msg(P.NAME, V.WRONG_DATA_FORMAT)],
    [`Ali ${'a'.repeat(61)}`, msg(P.NAME, V.MAX_LENGTH, 64)],
    ['', msg(P.NAME, V.NOT_EMPTY)],
    [42, msg(P.NAME, V.MUST_BE_STRING)],
  ])('%j -> üç DTO aynı sonucu verir', (fullName, expected) => {
    expect(nameErrorOf.register(fullName)).toBe(expected);
    expect(nameErrorOf.createUser(fullName)).toBe(expected);
    expect(nameErrorOf.updateMe(fullName)).toBe(expected);
  });

  it('gönderilmeyen isim: Register/CreateUser NOT_EMPTY, UpdateMe opsiyonel', () => {
    expect(nameErrorOf.register(undefined)).toBe(msg(P.NAME, V.NOT_EMPTY));
    expect(nameErrorOf.createUser(undefined)).toBe(msg(P.NAME, V.NOT_EMPTY));
    expect(nameErrorOf.updateMe(undefined)).toBeUndefined();
  });
});
