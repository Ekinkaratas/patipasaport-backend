jest.mock('./redis/redis.service', () => ({
  RedisService: class RedisServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { generateKeyPairSync } from 'crypto';
import { access } from '@libs/proto';
import { ResponseMessages, runWithCorrelationId } from '@libs/common';
import { AppService } from './app.service';
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

describe('AppService', () => {
  let service: AppService;
  let jwtService: JwtService;
  let redis: { getTokenRecord: jest.Mock; deleteTokenRecord: jest.Mock };

  const request: access.ExchangeTokenRequest = {
    opaqueToken: 'opaque-abc',
    clientType: access.ClientType.WEB,
  };

  beforeEach(async () => {
    redis = {
      getTokenRecord: jest.fn(),
      deleteTokenRecord: jest.fn().mockResolvedValue(true),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
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

    service = moduleRef.get(AppService);
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

    it('clientType uyusmazsa INVALID_TOKEN atar (web token mobilde gecmez)', async () => {
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
});
