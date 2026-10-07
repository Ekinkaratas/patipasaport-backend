import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { access } from '@libs/proto';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { CheckAccessRequestDto } from './check-access.dto';
import { ExchangeTokenRequestDto } from './exchange-token.dto';
import { GetConsentStatusRequestDto } from './get-consent-status.dto';
import { GrantConsentRequestDto } from './grant-consent.dto';
import { RevokeConsentRequestDto } from './revoke-consent.dto';
import { RevokeTokenRequestDto } from './revoke-token.dto';

// GrantConsent.scopes ve CheckAccess.requiredScopes aynı kural setini taşır.
const scopeCases = [
  ['yok', undefined, msg(P.SCOPES, V.MUST_BE_ARRAY)],
  ['string', 'medical_read', msg(P.SCOPES, V.MUST_BE_ARRAY)],
  ['boş dizi', [], msg(P.SCOPES, V.MIN, 1)],
  [
    'tekrarlı',
    ['medical_read', 'medical_read'],
    msg(P.SCOPES, V.MUST_BE_UNIQUE),
  ],
  ['bilinmeyen', ['foo'], msg(P.SCOPES, V.NOT_VALID)],
] as const;

describe('GrantConsentRequestDto', () => {
  const valid = {
    clinicId: UUID_A,
    petId: UUID_B,
    scopes: ['medical_read', 'vaccination_read'],
    expiresAt: '2027-01-01T00:00:00Z',
  };
  const check = (o: object) =>
    firstErrors(GrantConsentRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each(scopeCases)('scopes %s', (_n, scopes, expected) => {
    expect(check({ scopes })).toEqual({ scopes: expected });
  });

  it.each([
    [
      'clinicId bozuk',
      { clinicId: 'abc' },
      'clinicId',
      msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'petId yok',
      { petId: undefined },
      'petId',
      msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'expiresAt tarih değil',
      { expiresAt: 'yarın' },
      'expiresAt',
      msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    ],
    [
      'expiresAt saat dilimi yok',
      { expiresAt: '2027-01-01T00:00:00' },
      'expiresAt',
      msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    ],
    [
      'expiresAt yalnızca tarih',
      { expiresAt: '2027-01-01' },
      'expiresAt',
      msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    ],
    [
      'expiresAt takvimde olmayan gün',
      { expiresAt: '2027-02-30T00:00:00Z' },
      'expiresAt',
      msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });

  it('saat dilimi ofsetli expiresAt kabul edilir', () =>
    expect(check({ expiresAt: '2027-01-01T03:00:00+03:00' })).toEqual({}));
});

describe('CheckAccessRequestDto', () => {
  const valid = {
    clinicId: UUID_A,
    petId: UUID_B,
    requiredScopes: ['medical_read'],
  };
  const check = (o: object) =>
    firstErrors(CheckAccessRequestDto, { ...valid, ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each(scopeCases)('requiredScopes %s', (_n, requiredScopes, expected) => {
    expect(check({ requiredScopes })).toEqual({ requiredScopes: expected });
  });

  it.each([
    [
      'clinicId bozuk',
      { clinicId: 'abc' },
      'clinicId',
      msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    ],
    [
      'petId yok',
      { petId: undefined },
      'petId',
      msg(P.PET_ID, V.WRONG_DATA_FORMAT),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

describe('ExchangeTokenRequestDto', () => {
  const check = (o: object) =>
    firstErrors(ExchangeTokenRequestDto, {
      opaqueToken: 'tok',
      clientType: access.ClientType.WEB,
      ...o,
    });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    [
      'opaqueToken yok',
      { opaqueToken: undefined },
      'opaqueToken',
      msg(P.OPAQUE_TOKEN, V.NOT_EMPTY),
    ],
    [
      'opaqueToken sayı',
      { opaqueToken: 1 },
      'opaqueToken',
      msg(P.OPAQUE_TOKEN, V.MUST_BE_STRING),
    ],
    [
      'clientType UNSPECIFIED',
      { clientType: 0 },
      'clientType',
      msg(P.CLIENT_TYPE, V.NOT_VALID),
    ],
  ])('%s', (_n, override, field, expected) => {
    expect(check(override)).toEqual({ [field]: expected });
  });
});

describe('RevokeTokenRequestDto', () => {
  const check = (o: object) =>
    firstErrors(RevokeTokenRequestDto, { opaqueToken: 'tok', ...o });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    ['yok', { opaqueToken: undefined }, msg(P.OPAQUE_TOKEN, V.NOT_EMPTY)],
    ['boş', { opaqueToken: '' }, msg(P.OPAQUE_TOKEN, V.NOT_EMPTY)],
    ['sayı', { opaqueToken: 1 }, msg(P.OPAQUE_TOKEN, V.MUST_BE_STRING)],
  ])('opaqueToken %s', (_n, override, expected) => {
    expect(check(override)).toEqual({ opaqueToken: expected });
  });
});

describe('tek kurallı UUID alanları', () => {
  it('GetConsentStatus geçerli / bozuk', () => {
    expect(
      firstErrors(GetConsentStatusRequestDto, {
        clinicId: UUID_A,
        petId: UUID_B,
      }),
    ).toEqual({});
    expect(
      firstErrors(GetConsentStatusRequestDto, { clinicId: 'x', petId: UUID_B }),
    ).toEqual({
      clinicId: msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    });
  });

  it('RevokeConsent geçerli / yok', () => {
    expect(firstErrors(RevokeConsentRequestDto, { consentId: UUID_A })).toEqual(
      {},
    );
    expect(firstErrors(RevokeConsentRequestDto, {})).toEqual({
      consentId: msg(P.CONSENT_ID, V.WRONG_DATA_FORMAT),
    });
  });
});
