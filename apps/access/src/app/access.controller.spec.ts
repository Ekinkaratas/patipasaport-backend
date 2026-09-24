import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access } from '@libs/proto';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

describe('AccessController', () => {
  let controller: AccessController;
  let accessService: { exchangeToken: jest.Mock };

  const request: access.ExchangeTokenRequest = {
    opaqueToken: 'opaque-abc',
    clientType: access.ClientType.WEB,
  };

  beforeEach(async () => {
    accessService = { exchangeToken: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessController],
      providers: [{ provide: AccessService, useValue: accessService }],
    }).compile();

    controller = moduleRef.get(AccessController);
  });

  describe('gRPC handler kaydi', () => {
    it('exchangeToken AccessService.ExchangeToken rpc-sine baglidir', () => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AccessController.prototype.exchangeToken,
      );

      expect(pattern).toEqual([
        expect.objectContaining({
          service: 'AccessService',
          rpc: 'ExchangeToken',
        }),
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
});
