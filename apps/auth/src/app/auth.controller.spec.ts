import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { auth } from '@libs/proto';
import { IS_PUBLIC_KEY } from '@libs/common';
import {
  LoginRequestDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RegisterRequestDto,
} from '@libs/dto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    register: jest.Mock;
    login: jest.Mock;
    refreshToken: jest.Mock;
    logout: jest.Mock;
  };

  const tokenResponse: auth.TokenResponse = {
    accessToken: 'opaque-abc',
    refreshToken: 'refresh-abc',
    tokenType: 'Bearer',
    expiresIn: 900,
    userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
    clinicId: '',
    refreshExpiresIn: 43200,
  };

  const requests = {
    register: {
      email: 'ali@example.com',
      password: 'Sifre123!',
      fullName: 'Ali Veli',
      phone: '+905551234567',
      clientType: auth.ClientType.WEB,
    } as RegisterRequestDto,
    login: {
      email: 'ali@example.com',
      password: 'Sifre123!',
      clientType: auth.ClientType.WEB,
      rememberMe: false,
    } as LoginRequestDto,
    refreshToken: {
      refreshToken: 'refresh-abc',
      clientType: auth.ClientType.WEB,
    } as RefreshTokenRequestDto,
    logout: {
      refreshToken: 'refresh-abc',
      opaqueToken: 'opaque-abc',
    } as LogoutRequestDto,
  };

  const responses = {
    register: tokenResponse,
    login: tokenResponse,
    refreshToken: tokenResponse,
    logout: { success: true } as auth.LogoutResponse,
  };

  type Method = keyof typeof requests;
  const methods: Method[] = ['register', 'login', 'refreshToken', 'logout'];

  beforeEach(async () => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      refreshToken: jest.fn(),
      logout: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya ve erişim kuralına bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydi', () => {
    it.each([
      ['register', 'Register'],
      ['login', 'Login'],
      ['refreshToken', 'RefreshToken'],
      ['logout', 'Logout'],
    ])('%s, AuthService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AuthController.prototype[method as Method],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: auth.AUTH_SERVICE_NAME, rpc }),
      ]);
    });

    it.each([
      ['register', RegisterRequestDto],
      ['login', LoginRequestDto],
      ['refreshToken', RefreshTokenRequestDto],
      ['logout', LogoutRequestDto],
    ])(
      '%s parametresi dogrulama icin DTO sinifiyla tiplenmistir',
      (method, dto) => {
        const paramTypes = Reflect.getMetadata(
          'design:paramtypes',
          AuthController.prototype,
          method,
        );

        expect(paramTypes).toEqual([dto]);
      },
    );

    it.each(methods)(
      '%s @Public isaretlidir (kullanici JWT si olmadan cagrilir)',
      (method) => {
        expect(
          Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype[method]),
        ).toBe(true);
      },
    );

    it('DeleteInCredential gRPC uzerinden disariya acik degildir', () => {
      expect(
        (AuthController.prototype as unknown as Record<string, unknown>)
          .deleteInCredential,
      ).toBeUndefined();
    });
  });

  // ---Amaç: her handler'ın isteği servise olduğu gibi devrettiğini doğrulamak ---
  describe.each(methods)('%s', (method) => {
    it('istegi AuthService-e oldugu gibi devreder', async () => {
      authService[method].mockResolvedValue(responses[method]);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).resolves.toBe(responses[method]);
      expect(authService[method]).toHaveBeenCalledWith(requests[method]);
      expect(authService[method]).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('servis hatasi');
      authService[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).rejects.toBe(error);
    });
  });
});
