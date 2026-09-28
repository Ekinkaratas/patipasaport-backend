import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access } from '@libs/proto';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

describe('AccessController', () => {
  let controller: AccessController;
  let accessService: {
    exchangeToken: jest.Mock;
    createOpaqueToken: jest.Mock;
    revokeToken: jest.Mock;
  };

  const request: access.ExchangeTokenRequest = {
    opaqueToken: 'opaque-abc',
    clientType: access.ClientType.WEB,
  };

  beforeEach(async () => {
    accessService = {
      exchangeToken: jest.fn(),
      createOpaqueToken: jest.fn(),
      revokeToken: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessController],
      providers: [{ provide: AccessService, useValue: accessService }],
    }).compile();

    controller = moduleRef.get(AccessController);
  });

  describe('gRPC handler kaydi', () => {
    it.each([
      ['exchangeToken', 'ExchangeToken'],
      ['createOpaqueToken', 'CreateOpaqueToken'],
      ['revokeToken', 'RevokeToken'],
    ])('%s, AccessService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AccessController.prototype[method as keyof AccessController],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: 'AccessService', rpc }),
      ]);
    });
  });

  describe('exchangeToken', () => {
    it('istegi AccessService-e oldugu gibi devreder', async () => {
      const expected: access.ExchangeTokenResponse = {
        jwt: 'imzali.jwt.token',
        expiresIn: 60,
        traceId: 'TEST-CORRELATION-ID',
        userId: 'user-123',
        role: 'PET_OWNER',
        clinicId: '',
        clientType: access.ClientType.WEB,
      };
      accessService.exchangeToken.mockResolvedValue(expected);

      await expect(controller.exchangeToken(request)).resolves.toBe(expected);
      expect(accessService.exchangeToken).toHaveBeenCalledWith(request);
      expect(accessService.exchangeToken).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('INVALID_TOKEN');
      accessService.exchangeToken.mockRejectedValue(error);

      await expect(controller.exchangeToken(request)).rejects.toBe(error);
    });
  });

  describe('createOpaqueToken', () => {
    const payload: access.CreateTokenRequest = {
      userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      scopes: [],
      ttlSeconds: 900,
    };

    it('istegi AccessService-e oldugu gibi devreder', async () => {
      const expected: access.CreateTokenResponse = {
        opaqueToken: 'opaque-abc',
        expiresIn: 900,
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:15:00.000Z',
      };
      accessService.createOpaqueToken.mockResolvedValue(expected);

      await expect(controller.createOpaqueToken(payload)).resolves.toBe(
        expected,
      );
      expect(accessService.createOpaqueToken).toHaveBeenCalledWith(payload);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('VALIDATION_ERROR');
      accessService.createOpaqueToken.mockRejectedValue(error);

      await expect(controller.createOpaqueToken(payload)).rejects.toBe(error);
    });
  });

  describe('revokeToken', () => {
    const payload: access.RevokeTokenRequest = { opaqueToken: 'opaque-abc' };

    it('istegi AccessService-e oldugu gibi devreder', async () => {
      const expected: access.RevokeTokenResponse = { revoked: true };
      accessService.revokeToken.mockResolvedValue(expected);

      await expect(controller.revokeToken(payload)).resolves.toBe(expected);
      expect(accessService.revokeToken).toHaveBeenCalledWith(payload);
    });

    it('kayit bulunamadi yanitini oldugu gibi gecirir', async () => {
      accessService.revokeToken.mockResolvedValue({ revoked: false });

      await expect(controller.revokeToken(payload)).resolves.toEqual({
        revoked: false,
      });
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('BAD_REQUEST');
      accessService.revokeToken.mockRejectedValue(error);

      await expect(controller.revokeToken(payload)).rejects.toBe(error);
    });
  });
});
