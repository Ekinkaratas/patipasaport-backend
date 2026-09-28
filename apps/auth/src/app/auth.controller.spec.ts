import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { auth } from '@libs/proto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { register: jest.Mock; deleteInCredential: jest.Mock };

  const request = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    fullName: 'Ali Veli',
    phone: '+905551234567',
    clientType: auth.ClientType.WEB,
  } as auth.RegisterRequest;

  beforeEach(async () => {
    authService = { register: jest.fn(), deleteInCredential: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  describe('gRPC handler kaydi', () => {
    it.each([
      ['register', 'Register'],
      ['deleteInCredential', 'DeleteInCredential'],
    ])('%s, AuthService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AuthController.prototype[method as keyof AuthController],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: 'AuthService', rpc }),
      ]);
    });
  });

  describe('register', () => {
    it('istegi AuthService-e oldugu gibi devreder', async () => {
      const expected: auth.TokenResponse = {
        accessToken: 'opaque-abc',
        refreshToken: 'refresh-abc',
        tokenType: 'Bearer',
        expiresIn: 900,
        userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
      };
      authService.register.mockResolvedValue(expected);

      await expect(controller.register(request)).resolves.toBe(expected);
      expect(authService.register).toHaveBeenCalledWith(request);
      expect(authService.register).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('EMAIL_ALREADY_EXISTS');
      authService.register.mockRejectedValue(error);

      await expect(controller.register(request)).rejects.toBe(error);
    });
  });

  describe('deleteInCredential', () => {
    const payload: auth.DeleteInCredentialRequest = {
      userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
    };

    it('istegi AuthService-e oldugu gibi devreder', async () => {
      const expected: auth.DeleteInCredentialResponse = { deleted: true };
      authService.deleteInCredential.mockResolvedValue(expected);

      await expect(controller.deleteInCredential(payload)).resolves.toBe(
        expected,
      );
      expect(authService.deleteInCredential).toHaveBeenCalledWith(payload);
    });

    it('kayit bulunamadi yanitini oldugu gibi gecirir', async () => {
      authService.deleteInCredential.mockResolvedValue({ deleted: false });

      await expect(controller.deleteInCredential(payload)).resolves.toEqual({
        deleted: false,
      });
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('BAD_REQUEST');
      authService.deleteInCredential.mockRejectedValue(error);

      await expect(controller.deleteInCredential(payload)).rejects.toBe(error);
    });
  });
});
