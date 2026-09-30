import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { auth } from '@libs/proto';
import { LoginRequestDto, RegisterRequestDto } from '@libs/dto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { register: jest.Mock; login: jest.Mock };

  const registerRequest = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    fullName: 'Ali Veli',
    phone: '+905551234567',
    clientType: auth.ClientType.WEB,
  } as RegisterRequestDto;

  const loginRequest = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    clientType: auth.ClientType.WEB,
    rememberMe: false,
  } as LoginRequestDto;

  const tokenResponse: auth.TokenResponse = {
    accessToken: 'opaque-abc',
    refreshToken: 'refresh-abc',
    tokenType: 'Bearer',
    expiresIn: 900,
    userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  };

  beforeEach(async () => {
    authService = { register: jest.fn(), login: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  describe('gRPC handler kaydi', () => {
    it.each([
      ['register', 'Register'],
      ['login', 'Login'],
    ])('%s, AuthService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AuthController.prototype[method as keyof AuthController],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: 'AuthService', rpc }),
      ]);
    });

    // Global ValidationPipe yalnızca parametre tipi DTO sınıfıysa çalışır.
    it.each([
      ['register', RegisterRequestDto],
      ['login', LoginRequestDto],
    ])('%s parametresi dogrulama icin DTO sinifiyla tiplenmistir', (method, dto) => {
      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        AuthController.prototype,
        method,
      );

      expect(paramTypes).toEqual([dto]);
    });

    it('DeleteInCredential gRPC uzerinden disariya acik degildir', () => {
      expect(
        (AuthController.prototype as unknown as Record<string, unknown>)
          .deleteInCredential,
      ).toBeUndefined();
    });
  });

  describe('register', () => {
    it('istegi AuthService-e oldugu gibi devreder', async () => {
      authService.register.mockResolvedValue(tokenResponse);

      await expect(controller.register(registerRequest)).resolves.toBe(
        tokenResponse,
      );
      expect(authService.register).toHaveBeenCalledWith(registerRequest);
      expect(authService.register).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('EMAIL_ALREADY_EXISTS');
      authService.register.mockRejectedValue(error);

      await expect(controller.register(registerRequest)).rejects.toBe(error);
    });
  });

  describe('login', () => {
    it('istegi AuthService-e oldugu gibi devreder', async () => {
      authService.login.mockResolvedValue(tokenResponse);

      await expect(controller.login(loginRequest)).resolves.toBe(tokenResponse);
      expect(authService.login).toHaveBeenCalledWith(loginRequest);
      expect(authService.login).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('PASSWORD_OR_EMAIL_WRONG');
      authService.login.mockRejectedValue(error);

      await expect(controller.login(loginRequest)).rejects.toBe(error);
    });
  });
});
