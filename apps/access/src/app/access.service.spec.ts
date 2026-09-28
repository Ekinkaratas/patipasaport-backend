jest.mock('./redis/redis.service', () => ({
  RedisService: class RedisServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { generateKeyPairSync } from 'crypto';
import { access } from '@libs/proto';
import { ResponseMessages, runWithCorrelationId } from '@libs/common';
import { AccessService } from './access.service';
import { RedisService } from './redis/redis.service';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';

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
  scopes: ['medical_read'],
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe('AccessService', () => {
  let service: AccessService;
  let jwtService: JwtService;
  let redis: {
    getTokenRecord: jest.Mock;
    deleteTokenRecord: jest.Mock;
    createTokenRecord: jest.Mock;
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessService,
        { provide: RedisService, useValue: redis },
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
      expect(payload.scopes).toEqual(VALID_RECORD.scopes);
      expect(payload.exp - payload.iat).toBe(ACCESS_JWT_TTL_SECONDS);
    });

    it('opaque token ic alanlarini JWT payload gomulmez', async () => {
      const { jwt } = await service.exchangeToken(request);
      const payload = jwtService.verify(jwt, { publicKey });

      expect(payload.issuedAt).toBeUndefined();
      expect(payload.expiresAt).toBeUndefined();
      expect(payload.userId).toBeUndefined();
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

  describe('createOpaqueToken - basarili akis', () => {
    const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
    const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';

    const petOwner: access.CreateTokenRequest = {
      userId: USER_ID,
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      scopes: ['medical_read'],
      ttlSeconds: 0,
    };
    const staff: access.CreateTokenRequest = {
      ...petOwner,
      role: 'STAFF',
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
        scopes: ['medical_read'],
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

    it('klinik personeli UUID v4 clinicId ile kabul edilir, ttlSeconds iletilir', async () => {
      await service.createOpaqueToken({ ...staff, ttlSeconds: 300 });
      expect(redis.createTokenRecord.mock.calls[0][2]).toBe(300);
    });

    it('VETERINARIAN rolu de klinikle kabul edilir', async () => {
      await expect(
        service.createOpaqueToken({ ...staff, role: 'VETERINARIAN' }),
      ).resolves.toBeDefined();
    });

    it('bos scopes listesi kabul edilir ve kayda dizi olarak yazilir', async () => {
      await service.createOpaqueToken({ ...petOwner, scopes: [] });

      const [, record] = redis.createTokenRecord.mock.calls[0];
      expect(record.scopes).toEqual([]);
    });

    it('scopes gonderilmezse kayda bos dizi yazilir', async () => {
      await service.createOpaqueToken({
        ...petOwner,
        scopes: undefined as unknown as string[],
      });

      const [, record] = redis.createTokenRecord.mock.calls[0];
      expect(Array.isArray(record.scopes)).toBe(true);
      expect(record.scopes).toEqual([]);
    });

    it('scopes undefined iken dogrulama cokmez', async () => {
      await expect(
        service.createOpaqueToken({
          ...petOwner,
          scopes: undefined as unknown as string[],
        }),
      ).resolves.toBeDefined();
    });

    it('birden fazla gecerli scope kabul edilir', async () => {
      await service.createOpaqueToken({
        ...petOwner,
        scopes: ['medical_read', 'vaccination_read'],
      });

      const [, record] = redis.createTokenRecord.mock.calls[0];
      expect(record.scopes).toEqual(['medical_read', 'vaccination_read']);
    });
  });

  describe('createOpaqueToken - reddetme akislari', () => {
    const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
    const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';

    const petOwner: access.CreateTokenRequest = {
      userId: USER_ID,
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      scopes: ['medical_read'],
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
        'personel clinicId olmadan',
        { role: 'STAFF' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'personel clinicId bosluktan ibaret',
        { role: 'STAFF', clinicId: '   ' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'personel clinicId UUID degil',
        { role: 'VETERINARIAN', clinicId: 'clinic-1' },
        ResponseMessages.VALIDATION_ERROR,
      ],
      [
        'scope CONSENT_SCOPES disinda',
        { scopes: ['admin'] },
        ResponseMessages.VALIDATION_ERROR,
      ],
      ['scope bos string', { scopes: [''] }, ResponseMessages.VALIDATION_ERROR],
      [
        'scope tekrarli',
        { scopes: ['medical_read', 'medical_read'] },
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
});
