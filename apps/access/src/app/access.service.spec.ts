jest.mock('./redis/redis.service', () => ({
  RedisService: class RedisServiceMock {},
}));

jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { generateKeyPairSync } from 'crypto';
import { access } from '@libs/proto';
import {
  AuthUser,
  CONSENT_SCOPES,
  ConsentScope,
  ResponseMessages,
  runWithCorrelationId,
} from '@libs/common';
import { AccessService } from './access.service';
import { RedisService } from './redis/redis.service';
import { PrismaService } from './prisma/prisma.service';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';
import {
  Consent,
  ConsentStatus as DbConsentStatus,
} from '../generated/prisma/client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const VALID_RECORD = {
  userId: 'user-123',
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const OTHER_CLINIC_ID = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const PET_OWNER_ID = '8f9e0d1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f';
const CONSENT_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';

const COLUMN_OF: Record<ConsentScope, keyof Consent> = {
  medical_read: 'medicalRead',
  medical_write: 'medicalWrite',
  vaccination_read: 'vaccinationRead',
  prescription_read: 'prescriptionRead',
  chip_number_read: 'chipNumberRead',
  owner_contact_read: 'ownerContactRead',
};

const ALL_SCOPES_CLOSED = {
  medicalRead: false,
  medicalWrite: false,
  vaccinationRead: false,
  prescriptionRead: false,
  chipNumberRead: false,
  ownerContactRead: false,
};

const ALL_SCOPES_OPEN = {
  medicalRead: true,
  medicalWrite: true,
  vaccinationRead: true,
  prescriptionRead: true,
  chipNumberRead: true,
  ownerContactRead: true,
};

// ---Amaç: veritabanından dönen rıza satırını üretmek ---
const consentRow = (overrides: Partial<Consent> = {}): Consent => ({
  id: CONSENT_ID,
  clinicId: CLINIC_ID,
  petId: PET_ID,
  petOwnerId: PET_OWNER_ID,
  ...ALL_SCOPES_CLOSED,
  medicalRead: true,
  vaccinationRead: true,
  status: DbConsentStatus.ACTIVE,
  expiresAt: new Date(Date.now() + DAY_MS),
  revokedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

// ---Amaç: CheckAccess isteğini üretmek ---
const checkRequest = (
  requiredScopes: string[],
  clinicId = CLINIC_ID,
): access.CheckAccessRequest => ({ clinicId, petId: PET_ID, requiredScopes });

const CLINIC_USER: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: CLINIC_ID,
  clientType: access.ClientType.WEB,
};

describe('AccessService', () => {
  let service: AccessService;
  let jwtService: JwtService;
  let redis: {
    getTokenRecord: jest.Mock;
    deleteTokenRecord: jest.Mock;
    createTokenRecord: jest.Mock;
  };
  let prisma: {
    consent: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };

  const request: access.ExchangeTokenRequest = {
    opaqueToken: 'opaque-abc',
    clientType: access.ClientType.WEB,
  };

  beforeEach(async () => {
    redis = {
      getTokenRecord: jest.fn(),
      deleteTokenRecord: jest.fn().mockResolvedValue(true),
      createTokenRecord: jest.fn().mockResolvedValue({
        ttlSeconds: 3600,
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T01:00:00.000Z',
      }),
    };
    prisma = {
      consent: { findUnique: jest.fn() },
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessService,
        { provide: RedisService, useValue: redis },
        { provide: PrismaService, useValue: prisma },
        { provide: 'PETS_SERVICE', useValue: {} },
        { provide: 'CLINIC_SERVİCE', useValue: {} },
        {
          provide: JwtService,
          useValue: new JwtService({
            privateKey,
            publicKey,
            signOptions: {
              algorithm: 'RS256',
              expiresIn: ACCESS_JWT_TTL_SECONDS,
              issuer: 'access',
            },
            verifyOptions: { algorithms: ['RS256'], issuer: 'access' },
          }),
        },
      ],
    }).compile();

    service = moduleRef.get(AccessService);
    jwtService = moduleRef.get(JwtService);
  });

  // ---Amaç: geçerli opaque token'ın imzalı JWT'ye çevrildiğini doğrulamak ---
  describe('exchangeToken - basarili akis', () => {
    beforeEach(() => redis.getTokenRecord.mockResolvedValue(VALID_RECORD));

    it('proto sozlesmesindeki tum alanlari doldurur', async () => {
      const response = await service.exchangeToken(request);

      expect(response.userId).toBe(VALID_RECORD.userId);
      expect(response.role).toBe(VALID_RECORD.role);
      expect(response.clinicId).toBe(VALID_RECORD.clinicId);
      expect(response.clientType).toBe(access.ClientType.WEB);
      expect(response.expiresIn).toBe(ACCESS_JWT_TTL_SECONDS);
      expect(response.jwt).toBeTruthy();
    });

    it('uretilen JWT acik anahtarla dogrulanir ve RS256 ile imzalanmistir', async () => {
      const { jwt } = await service.exchangeToken(request);

      const header = JSON.parse(
        Buffer.from(jwt.split('.')[0], 'base64url').toString(),
      );
      expect(header.alg).toBe('RS256');

      const payload = jwtService.verify(jwt, {
        publicKey,
        algorithms: ['RS256'],
        issuer: 'access',
      });
      expect(payload.sub).toBe(VALID_RECORD.userId);
      expect(payload.role).toBe(VALID_RECORD.role);
      expect(payload.clinicId).toBe(VALID_RECORD.clinicId);
      expect(payload.clientType).toBe(VALID_RECORD.clientType);
      expect(payload.exp - payload.iat).toBe(ACCESS_JWT_TTL_SECONDS);
    });

    it('opaque token ic alanlarini JWT payload gomulmez', async () => {
      const { jwt } = await service.exchangeToken(request);
      const payload = jwtService.verify(jwt, { publicKey });

      expect(payload.issuedAt).toBeUndefined();
      expect(payload.expiresAt).toBeUndefined();
      expect(payload.userId).toBeUndefined();
      expect(payload.scopes).toBeUndefined();
    });

    it('traceId, istegin correlationId degerini tasir', async () => {
      const response = await runWithCorrelationId('TEST-CORRELATION-ID', () =>
        service.exchangeToken(request),
      );

      expect(response.traceId).toBe('TEST-CORRELATION-ID');
    });

    it('istek baglami disinda traceId SYSTEM olur', async () => {
      const response = await service.exchangeToken(request);
      expect(response.traceId).toBe('SYSTEM');
    });

    it('gecerli token silinmez', async () => {
      await service.exchangeToken(request);
      expect(redis.deleteTokenRecord).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: geçersiz, süresi dolmuş veya başka istemciye bağlı token'ın reddedildiğini doğrulamak ---
  describe('exchangeToken - reddetme akislari', () => {
    it('kayit yoksa INVALID_TOKEN atar', async () => {
      redis.getTokenRecord.mockResolvedValue(null);

      await expect(service.exchangeToken(request)).rejects.toThrow(
        RpcException,
      );
      await expect(service.exchangeToken(request)).rejects.toThrow(
        ResponseMessages.INVALID_TOKEN,
      );
    });

    it('suresi gecmis kaydi siler ve TOKEN_EXPIRED atar', async () => {
      redis.getTokenRecord.mockResolvedValue({
        ...VALID_RECORD,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      await expect(service.exchangeToken(request)).rejects.toThrow(
        ResponseMessages.TOKEN_EXPIRED,
      );
      expect(redis.deleteTokenRecord).toHaveBeenCalledWith(request.opaqueToken);
    });

    it('clientType uyusmazsa INVALID_TOKEN atar', async () => {
      redis.getTokenRecord.mockResolvedValue({
        ...VALID_RECORD,
        clientType: access.ClientType.WEB,
      });

      await expect(
        service.exchangeToken({
          ...request,
          clientType: access.ClientType.MOBILE,
        }),
      ).rejects.toThrow(ResponseMessages.INVALID_TOKEN);
    });

    it('clientType uyusmazliginda kayit SILINMEZ', async () => {
      redis.getTokenRecord.mockResolvedValue(VALID_RECORD);

      await service
        .exchangeToken({ ...request, clientType: access.ClientType.MOBILE })
        .catch(() => undefined);

      expect(redis.deleteTokenRecord).not.toHaveBeenCalled();
    });

    it('kayit yok ile clientType uyusmazligi ayni kodu doner', async () => {
      redis.getTokenRecord.mockResolvedValue(null);
      const notFound = await service.exchangeToken(request).catch((e) => e);

      redis.getTokenRecord.mockResolvedValue(VALID_RECORD);
      const mismatch = await service
        .exchangeToken({ ...request, clientType: access.ClientType.MOBILE })
        .catch((e) => e);

      expect(notFound.message).toBe(mismatch.message);
    });
  });

  // ---Amaç: geçerli kullanıcı bilgisiyle opaque token kaydının oluşturulduğunu doğrulamak ---
  describe('createOpaqueToken - basarili akis', () => {
    const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';

    const petOwner: access.CreateTokenRequest = {
      userId: USER_ID,
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      ttlSeconds: 0,
    };
    const clinic: access.CreateTokenRequest = {
      ...petOwner,
      role: 'CLINIC',
      clinicId: CLINIC_ID,
    };

    it('kaydi olusturur, ttlSeconds 0 ise varsayilan TTL istenir', async () => {
      const response = await service.createOpaqueToken(petOwner);

      const [opaqueToken, record, ttl] = redis.createTokenRecord.mock.calls[0];
      expect(typeof opaqueToken).toBe('string');
      expect(record).toEqual({
        userId: USER_ID,
        role: 'PET_OWNER',
        clinicId: '',
        clientType: access.ClientType.WEB,
      });
      expect(ttl).toBeUndefined();
      expect(response).toEqual({
        opaqueToken,
        expiresIn: 3600,
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T01:00:00.000Z',
      });
    });

    it('uretilen opaque token 256 bit entropili base64url dizesidir', async () => {
      await service.createOpaqueToken(petOwner);

      const [opaqueToken] = redis.createTokenRecord.mock.calls[0];
      expect(opaqueToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('her cagri farkli token uretir', async () => {
      await service.createOpaqueToken(petOwner);
      await service.createOpaqueToken(petOwner);

      const [first] = redis.createTokenRecord.mock.calls[0];
      const [second] = redis.createTokenRecord.mock.calls[1];
      expect(first).not.toBe(second);
    });

    it('token yanitta doner ama kayit icine yazilmaz', async () => {
      const response = await service.createOpaqueToken(petOwner);

      const [, record] = redis.createTokenRecord.mock.calls[0];
      expect(response.opaqueToken).toBeTruthy();
      expect(record).not.toHaveProperty('opaqueToken');
      expect(record).not.toHaveProperty('ttlSeconds');
    });

    it('klinik hesabi UUID v4 clinicId ile kabul edilir, ttlSeconds iletilir', async () => {
      await service.createOpaqueToken({ ...clinic, ttlSeconds: 300 });
      expect(redis.createTokenRecord.mock.calls[0][2]).toBe(300);
    });

    it('istekte olmayan alanlar kayda yazilmaz', async () => {
      await service.createOpaqueToken({
        ...petOwner,
        scopes: ['medical_read'],
      } as access.CreateTokenRequest);

      const [, record] = redis.createTokenRecord.mock.calls[0];
      expect(record).not.toHaveProperty('scopes');
    });
  });

  // ---Amaç: kurala uymayan isteklerin Redis'e yazılmadan reddedildiğini doğrulamak ---
  describe('createOpaqueToken - reddetme akislari', () => {
    const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';

    const petOwner: access.CreateTokenRequest = {
      userId: USER_ID,
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      ttlSeconds: 0,
    };

    it.each([
      ['ttlSeconds negatif', { ttlSeconds: -1 }, ResponseMessages.BAD_REQUEST],
      [
        'clientType UNSPECIFIED',
        { clientType: access.ClientType.CLIENT_TYPE_UNSPECIFIED },
        ResponseMessages.INVALID_CLIENT_TYPE,
      ],
      [
        'clientType UNRECOGNIZED',
        { clientType: access.ClientType.UNRECOGNIZED },
        ResponseMessages.INVALID_CLIENT_TYPE,
      ],
      [
        'userId UUID degil',
        { userId: 'user-123' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      ['userId yok', { userId: undefined }, ResponseMessages.VALIDATION_ERROR],
      [
        'role beyaz listede yok',
        { role: 'ADMIN' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'role USER_ROLE_UNSPECIFIED',
        { role: 'USER_ROLE_UNSPECIFIED' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'PET_OWNER klinige bagli',
        { clinicId: CLINIC_ID },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'kaldirilan STAFF rolu',
        { role: 'STAFF', clinicId: CLINIC_ID },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'eski VETERINARIAN rolu',
        { role: 'VETERINARIAN', clinicId: CLINIC_ID },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'klinik hesabi clinicId olmadan',
        { role: 'CLINIC' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'klinik hesabi clinicId bosluktan ibaret',
        { role: 'CLINIC', clinicId: '   ' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'klinik hesabi clinicId UUID degil',
        { role: 'CLINIC', clinicId: 'clinic-1' },
        ResponseMessages.VALIDATION_ERROR,
      ],
    ])('%s -> reddedilir ve kayit olusturulmaz', async (_n, override, code) => {
      const error = await service
        .createOpaqueToken({
          ...petOwner,
          ...override,
        } as access.CreateTokenRequest)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(code);
      expect(redis.createTokenRecord).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: opaque token'ın Redis'ten silinmesini ve hatalı girdilerin reddini doğrulamak ---
  describe('revokeToken', () => {
    it('kaydi siler ve revoked true doner', async () => {
      redis.deleteTokenRecord.mockResolvedValue(true);

      await expect(
        service.revokeToken({ opaqueToken: 'opaque-abc' }),
      ).resolves.toEqual({ revoked: true });
      expect(redis.deleteTokenRecord).toHaveBeenCalledWith('opaque-abc');
    });

    it('kayit yoksa revoked false doner ve hata atmaz', async () => {
      redis.deleteTokenRecord.mockResolvedValue(false);

      await expect(
        service.revokeToken({ opaqueToken: 'opaque-abc' }),
      ).resolves.toEqual({ revoked: false });
    });

    it('ayni token icin iki kez cagrilabilir', async () => {
      redis.deleteTokenRecord
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await expect(
        service.revokeToken({ opaqueToken: 'opaque-abc' }),
      ).resolves.toEqual({ revoked: true });
      await expect(
        service.revokeToken({ opaqueToken: 'opaque-abc' }),
      ).resolves.toEqual({ revoked: false });
    });

    it.each([[''], ['   '], [undefined], [null]])(
      'opaqueToken %p ise BAD_REQUEST atar ve redise gitmez',
      async (opaqueToken) => {
        const error = await service
          .revokeToken({ opaqueToken } as access.RevokeTokenRequest)
          .catch((e) => e);

        expect(error).toBeInstanceOf(RpcException);
        expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
        expect(redis.deleteTokenRecord).not.toHaveBeenCalled();
      },
    );

    it('redis hatasini oldugu gibi yukari tasir', async () => {
      const original = new Error('redis kapali');
      redis.deleteTokenRecord.mockRejectedValue(original);

      await expect(
        service.revokeToken({ opaqueToken: 'opaque-abc' }),
      ).rejects.toBe(original);
    });
  });

  // ---Amaç: rıza satırının durumuna ve scope sütunlarına göre verilen kararı doğrulamak ---
  describe('checkAccess - karar', () => {
    afterEach(() => jest.restoreAllMocks());

    it('aktif riza istenen tum scope-lari kapsiyorsa izin verir, yanit alanlari eksiksizdir', async () => {
      const row = consentRow();
      prisma.consent.findUnique.mockResolvedValue(row);

      await expect(
        service.checkAccess(
          checkRequest(['medical_read', 'vaccination_read']),
          CLINIC_USER,
        ),
      ).resolves.toEqual({
        allowed: true,
        grantedScopes: ['medical_read', 'vaccination_read'],
        missingScopes: [],
        consentId: CONSENT_ID,
        status: access.ConsentStatus.ACTIVE,
        expiresAt: row.expiresAt.toISOString(),
        deniedReason: access.DeniedReason.DENIED_REASON_UNSPECIFIED,
      });
    });

    it('riza istekteki clinicId ve petId ile tekil anahtardan aranir', async () => {
      prisma.consent.findUnique.mockResolvedValue(consentRow());

      await service.checkAccess(checkRequest(['medical_read']), CLINIC_USER);

      expect(prisma.consent.findUnique).toHaveBeenCalledWith({
        where: { clinicId_petId: { clinicId: CLINIC_ID, petId: PET_ID } },
      });
    });

    it('istenen scope-lardan biri eksikse izin vermez ve INSUFFICIENT_SCOPE doner', async () => {
      prisma.consent.findUnique.mockResolvedValue(consentRow());

      await expect(
        service.checkAccess(
          checkRequest(['medical_read', 'medical_write']),
          CLINIC_USER,
        ),
      ).resolves.toMatchObject({
        allowed: false,
        grantedScopes: ['medical_read'],
        missingScopes: ['medical_write'],
        status: access.ConsentStatus.ACTIVE,
        deniedReason: access.DeniedReason.DENIED_REASON_INSUFFICIENT_SCOPE,
      });
    });

    it.each(Object.entries(COLUMN_OF))(
      '%s yalnizca %s sutunu acikken verilmis sayilir',
      async (scope, column) => {
        prisma.consent.findUnique.mockResolvedValue(
          consentRow({ ...ALL_SCOPES_CLOSED, [column]: true }),
        );

        const response = await service.checkAccess(
          checkRequest([...CONSENT_SCOPES]),
          CLINIC_USER,
        );

        expect(response.grantedScopes).toEqual([scope]);
        expect(response.missingScopes).toEqual(
          CONSENT_SCOPES.filter((s) => s !== scope),
        );
        expect(response.allowed).toBe(false);
      },
    );

    it('bilinmeyen scope eksik sayilir ve izin verilmez', async () => {
      prisma.consent.findUnique.mockResolvedValue(consentRow(ALL_SCOPES_OPEN));

      await expect(
        service.checkAccess(
          checkRequest(['medical_read', 'admin']),
          CLINIC_USER,
        ),
      ).resolves.toMatchObject({
        allowed: false,
        grantedScopes: ['medical_read'],
        missingScopes: ['admin'],
        deniedReason: access.DeniedReason.DENIED_REASON_INSUFFICIENT_SCOPE,
      });
    });

    it('iptal edilmis riza scope-lari acik olsa da reddedilir ve hicbir scope verilmis sayilmaz', async () => {
      const row = consentRow({
        ...ALL_SCOPES_OPEN,
        status: DbConsentStatus.REVOKED,
        revokedAt: new Date(),
      });
      prisma.consent.findUnique.mockResolvedValue(row);

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).resolves.toEqual({
        allowed: false,
        grantedScopes: [],
        missingScopes: [],
        consentId: CONSENT_ID,
        status: access.ConsentStatus.REVOKED,
        expiresAt: row.expiresAt.toISOString(),
        deniedReason: access.DeniedReason.DENIED_REASON_REVOKED,
      });
    });

    it('suresi dolmus riza reddedilir ve EXPIRED doner', async () => {
      prisma.consent.findUnique.mockResolvedValue(
        consentRow({ expiresAt: new Date(Date.now() - 60_000) }),
      );

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).resolves.toMatchObject({
        allowed: false,
        grantedScopes: [],
        status: access.ConsentStatus.EXPIRED,
        deniedReason: access.DeniedReason.DENIED_REASON_EXPIRED,
      });
    });

    it('bitis ani tam simdiyse riza suresi dolmus sayilir', async () => {
      const now = Date.parse('2026-06-01T12:00:00.000Z');
      jest.spyOn(Date, 'now').mockReturnValue(now);
      prisma.consent.findUnique.mockResolvedValue(
        consentRow({ expiresAt: new Date(now) }),
      );

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).resolves.toMatchObject({
        allowed: false,
        status: access.ConsentStatus.EXPIRED,
      });
    });

    it('hem iptal edilmis hem suresi dolmus rizada REVOKED onceliklidir', async () => {
      prisma.consent.findUnique.mockResolvedValue(
        consentRow({
          status: DbConsentStatus.REVOKED,
          revokedAt: new Date(),
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).resolves.toMatchObject({
        allowed: false,
        status: access.ConsentStatus.REVOKED,
        deniedReason: access.DeniedReason.DENIED_REASON_REVOKED,
      });
    });

    it.each([
      [
        'status REVOKED, revokedAt bos',
        DbConsentStatus.REVOKED,
        null,
        false,
        access.ConsentStatus.REVOKED,
      ],
      [
        'status ACTIVE, revokedAt dolu',
        DbConsentStatus.ACTIVE,
        new Date(),
        true,
        access.ConsentStatus.ACTIVE,
      ],
    ])(
      'karar revokedAt-e degil status-e dayanir (%s)',
      async (_n, status, revokedAt, allowed, expectedStatus) => {
        prisma.consent.findUnique.mockResolvedValue(
          consentRow({ status, revokedAt }),
        );

        await expect(
          service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
        ).resolves.toMatchObject({ allowed, status: expectedStatus });
      },
    );

    it('riza kaydi yoksa NO_CONSENT ve NOT_FOUND doner', async () => {
      prisma.consent.findUnique.mockResolvedValue(null);

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).resolves.toEqual({
        allowed: false,
        grantedScopes: [],
        missingScopes: [],
        consentId: '',
        status: access.ConsentStatus.NOT_FOUND,
        expiresAt: '',
        deniedReason: access.DeniedReason.DENIED_REASON_NO_CONSENT,
      });
    });

    it('salt okumadir: transaction ve set_config calistirmaz', async () => {
      prisma.consent.findUnique.mockResolvedValue(consentRow());

      await service.checkAccess(checkRequest(['medical_read']), CLINIC_USER);

      expect(prisma.consent.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('veritabani hatasini yutmaz', async () => {
      const original = new Error('veritabani kapali');
      prisma.consent.findUnique.mockRejectedValue(original);

      await expect(
        service.checkAccess(checkRequest(['medical_read']), CLINIC_USER),
      ).rejects.toBe(original);
    });
  });

  // ---Amaç: kullanıcının yalnızca kendi kliniğinin rızasını sorgulayabildiğini doğrulamak ---
  describe('checkAccess - klinik yetkisi', () => {
    it.each([
      ['riza var', consentRow({ clinicId: OTHER_CLINIC_ID })],
      ['riza yok', null],
    ])(
      'baska klinigin clinicId-si ile FORBIDDEN atar ve veritabanina gitmez (%s)',
      async (_n, row) => {
        prisma.consent.findUnique.mockResolvedValue(row);

        const error = await service
          .checkAccess(
            checkRequest(['medical_read'], OTHER_CLINIC_ID),
            CLINIC_USER,
          )
          .catch((e) => e);

        expect(error).toBeInstanceOf(RpcException);
        expect(error.message).toBe(ResponseMessages.FORBIDDEN);
        expect(prisma.consent.findUnique).not.toHaveBeenCalled();
      },
    );

    it('PET_OWNER (clinicId bos) FORBIDDEN alir', async () => {
      const owner: AuthUser = {
        userId: PET_OWNER_ID,
        role: 'PET_OWNER',
        clinicId: '',
        clientType: access.ClientType.WEB,
      };

      const error = await service
        .checkAccess(checkRequest(['medical_read']), owner)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.consent.findUnique).not.toHaveBeenCalled();
    });
  });
});
