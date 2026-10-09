import { Test, TestingModule } from '@nestjs/testing';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access } from '@libs/proto';
import { AuthUser, IS_PUBLIC_KEY } from '@libs/common';
import {
  CheckAccessRequestDto,
  CreateTokenRequestDto,
  ExchangeTokenRequestDto,
  RevokeTokenRequestDto,
} from '@libs/dto';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

describe('AccessController', () => {
  let controller: AccessController;
  let accessService: {
    exchangeToken: jest.Mock;
    createOpaqueToken: jest.Mock;
    revokeToken: jest.Mock;
    checkAccess: jest.Mock;
  };

  const user: AuthUser = {
    userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
    role: 'CLINIC',
    clinicId: '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718',
    clientType: access.ClientType.WEB,
  };

  const requests = {
    exchangeToken: {
      opaqueToken: 'opaque-abc',
      clientType: access.ClientType.WEB,
    } as ExchangeTokenRequestDto,
    createOpaqueToken: {
      userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
      ttlSeconds: 900,
    } as CreateTokenRequestDto,
    revokeToken: { opaqueToken: 'opaque-abc' } as RevokeTokenRequestDto,
  };

  const responses = {
    exchangeToken: {
      jwt: 'imzali.jwt.token',
      expiresIn: 60,
      traceId: 'TEST-CORRELATION-ID',
      userId: 'user-123',
      role: 'PET_OWNER',
      clinicId: '',
      clientType: access.ClientType.WEB,
    } as access.ExchangeTokenResponse,
    createOpaqueToken: {
      opaqueToken: 'opaque-abc',
      expiresIn: 900,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
    } as access.CreateTokenResponse,
    revokeToken: { revoked: true } as access.RevokeTokenResponse,
  };

  const checkAccessRequest = {
    clinicId: user.clinicId,
    petId: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
    requiredScopes: ['medical_read'],
  } as CheckAccessRequestDto;

  type PublicMethod = keyof typeof requests;
  const publicMethods: PublicMethod[] = [
    'exchangeToken',
    'createOpaqueToken',
    'revokeToken',
  ];

  beforeEach(async () => {
    accessService = {
      exchangeToken: jest.fn(),
      createOpaqueToken: jest.fn(),
      revokeToken: jest.fn(),
      checkAccess: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessController],
      providers: [{ provide: AccessService, useValue: accessService }],
    }).compile();

    controller = moduleRef.get(AccessController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya ve erişim kuralına bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydi', () => {
    it.each([
      ['exchangeToken', 'ExchangeToken'],
      ['createOpaqueToken', 'CreateOpaqueToken'],
      ['revokeToken', 'RevokeToken'],
      ['checkAccess', 'CheckAccess'],
    ])('%s, AccessService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        AccessController.prototype[method as keyof AccessController],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: access.ACCESS_SERVICE_NAME, rpc }),
      ]);
    });

    it.each([
      ['exchangeToken', [ExchangeTokenRequestDto]],
      ['createOpaqueToken', [CreateTokenRequestDto]],
      ['revokeToken', [RevokeTokenRequestDto]],
      ['checkAccess', [CheckAccessRequestDto, Object]],
    ])(
      '%s parametresi dogrulama icin DTO sinifiyla tiplenmistir',
      (method, paramTypes) => {
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            AccessController.prototype,
            method,
          ),
        ).toEqual(paramTypes);
      },
    );

    it.each(publicMethods)(
      '%s @Public isaretlidir (kullanici JWT si olmadan cagrilir)',
      (method) => {
        expect(
          Reflect.getMetadata(
            IS_PUBLIC_KEY,
            AccessController.prototype[method],
          ),
        ).toBe(true);
      },
    );

    it('checkAccess @Public degildir (dogrulanmis JWT zorunlu)', () => {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          AccessController.prototype.checkAccess,
        ),
      ).toBeUndefined();
    });

    it('checkAccess kullaniciyi istek govdesinden degil @CurrentUser ile alir', () => {
      const args: Record<string, { index: number }> = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        AccessController,
        'checkAccess',
      );
      const userArg = Object.entries(args).find(([, arg]) => arg.index === 1);

      expect(userArg?.[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
    });
  });

  // ---Amaç: public handler'ların isteği servise olduğu gibi devrettiğini doğrulamak ---
  describe.each(publicMethods)('%s', (method) => {
    it('istegi AccessService-e oldugu gibi devreder', async () => {
      accessService[method].mockResolvedValue(responses[method]);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).resolves.toBe(responses[method]);
      expect(accessService[method]).toHaveBeenCalledWith(requests[method]);
      expect(accessService[method]).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('servis hatasi');
      accessService[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).rejects.toBe(error);
    });
  });

  // ---Amaç: checkAccess'in isteği ve doğrulanmış kullanıcıyı servise ilettiğini doğrulamak ---
  describe('checkAccess', () => {
    it('istegi ve kullaniciyi AccessService-e oldugu gibi devreder', async () => {
      const expected: access.CheckAccessResponse = {
        allowed: true,
        grantedScopes: ['medical_read'],
        missingScopes: [],
        consentId: '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f',
        status: access.ConsentStatus.ACTIVE,
        expiresAt: '2026-12-01T00:00:00.000Z',
        deniedReason: access.DeniedReason.DENIED_REASON_UNSPECIFIED,
        petOwnerId: '8f9e0d1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f',
      };
      accessService.checkAccess.mockResolvedValue(expected);

      await expect(
        controller.checkAccess(checkAccessRequest, user),
      ).resolves.toBe(expected);
      expect(accessService.checkAccess).toHaveBeenCalledWith(
        checkAccessRequest,
        user,
      );
      expect(accessService.checkAccess).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('FORBIDDEN');
      accessService.checkAccess.mockRejectedValue(error);

      await expect(
        controller.checkAccess(checkAccessRequest, user),
      ).rejects.toBe(error);
    });
  });
});
