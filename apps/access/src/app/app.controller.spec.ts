import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access } from '@libs/proto';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let controller: AppController;
  let appService: { exchangeToken: jest.Mock };

  const request: access.ExchangeTokenRequest = {
    opaqueToken: 'opaque-abc',
    clientType: access.ClientType.WEB,
  };

  beforeEach(async () => {
    appService = { exchangeToken: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: AppService, useValue: appService }],
    }).compile();

    controller = moduleRef.get(AppController);
  });

  describe('gRPC handler kaydi', () => {
    it('exchangeToken AccessService.ExchangeToken rpc-sine baglidir', () => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AppController.prototype.exchangeToken,
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
    it('istegi AppService-e oldugu gibi devreder', async () => {
      const expected: access.ExchangeTokenResponse = {
        jwt: 'imzali.jwt.token',
        expiresIn: 60,
        traceId: 'TEST-CORRELATION-ID',
        userId: 'user-123',
        role: 'PET_OWNER',
        clinicId: '',
        clientType: access.ClientType.WEB,
      };
      appService.exchangeToken.mockResolvedValue(expected);

      await expect(controller.exchangeToken(request)).resolves.toBe(expected);
      expect(appService.exchangeToken).toHaveBeenCalledWith(request);
      expect(appService.exchangeToken).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('INVALID_TOKEN');
      appService.exchangeToken.mockRejectedValue(error);

      await expect(controller.exchangeToken(request)).rejects.toBe(error);
    });
  });
});
