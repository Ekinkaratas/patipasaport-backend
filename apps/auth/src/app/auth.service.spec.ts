jest.mock('argon2', () => ({ hash: jest.fn(), verify: jest.fn() }));

jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

jest.mock('./redis/login-attempt.service', () => ({
  LoginAttemptService: class LoginAttemptServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { createHash } from 'crypto';
import { of, throwError } from 'rxjs';
import * as argon from 'argon2';
import { access, auth, users } from '@libs/proto';
import { ResponseMessages } from '@libs/common';
import { AuthService } from './auth.service';
import { PrismaService } from './prisma/prisma.service';
import { LoginAttemptService } from './redis/login-attempt.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_REUSE_TOLERANCE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants';
import { Prisma } from '../generated/prisma/client';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$hash';
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$dummy';
const CREDENTIAL_USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const FAMILY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REFRESH_TOKEN = 'mevcut-refresh-token';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---Amaç: Prisma'nın bilinen hata kodlarını taklit etmek ---
const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('test hatasi', {
    code,
    clientVersion: 'test',
  });

// ---Amaç: diğer servislerden dönen gRPC hatasını taklit etmek ---
const grpcError = (code: number, details?: string) =>
  Object.assign(new Error(details ?? 'grpc hatasi'), { code, details });

// ---Amaç: refresh token'ın veritabanındaki karşılığını hesaplamak ---
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('AuthService', () => {
  let service: AuthService;
  let usersClient: {
    createUser: jest.Mock;
    deleteUser: jest.Mock;
    getUserAuthInfo: jest.Mock;
  };
  let accessClient: { createOpaqueToken: jest.Mock; revokeToken: jest.Mock };
  let loginAttempts: {
    reserveAttempt: jest.Mock;
    recordFailure: jest.Mock;
    reset: jest.Mock;
  };
  let prisma: {
    credential: { create: jest.Mock; delete: jest.Mock; findUnique: jest.Mock };
    session: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const dto: auth.RegisterRequest = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    fullName: 'Ali Veli',
    phone: '+905551234567',
    clientType: auth.ClientType.WEB,
  };

  const loginDto: auth.LoginRequest = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    clientType: auth.ClientType.WEB,
    rememberMe: false,
  };

  const refreshDto: auth.RefreshTokenRequest = {
    refreshToken: REFRESH_TOKEN,
    clientType: auth.ClientType.WEB,
  };

  const logoutDto: auth.LogoutRequest = {
    refreshToken: REFRESH_TOKEN,
    opaqueToken: 'eski-opaque-token',
  };

  // ---Amaç: users.createUser yanıtını üretmek ---
  const usersResponse = (
    over: Partial<users.User> = {},
  ): users.UserResponse => ({
    user: {
      userId: 'users-tarafindan-dondurulen',
      email: dto.email,
      fullName: dto.fullName,
      phone: dto.phone,
      role: users.UserRole.PET_OWNER,
      clinicId: '',
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    },
  });

  // ---Amaç: users.getUserAuthInfo yanıtını üretmek ---
  const authInfoResponse = (
    over: Partial<users.GetUserAuthInfoResponse> = {},
  ): users.GetUserAuthInfoResponse => ({
    userId: CREDENTIAL_USER_ID,
    role: users.UserRole.PET_OWNER,
    clinicId: '',
    isActive: true,
    ...over,
  });

  // ---Amaç: refresh ve logout için veritabanındaki oturum satırını üretmek ---
  const sessionRow = (over: Record<string, unknown> = {}) => ({
    userId: CREDENTIAL_USER_ID,
    familyId: FAMILY_ID,
    clientType: 'WEB',
    rememberMe: true,
    expiresAt: new Date(Date.now() + DAY_MS),
    revokedAt: null,
    ...over,
  });

  const tokenResponse: access.CreateTokenResponse = {
    opaqueToken: 'opaque-abc-123',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:15:00.000Z',
  };

  // ---Amaç: ClientGrpc.getService'in döndüreceği istemciyi bağlamak ---
  const clientGrpcFor = (implementation: unknown): ClientGrpc =>
    ({ getService: () => implementation }) as unknown as ClientGrpc;

  // ---Amaç: oturumun bitiş zamanını iki zaman noktası arasında doğrulamak ---
  const expectExpiresWithin = (
    expiresAt: Date,
    before: number,
    after: number,
    ttlSeconds: number,
  ) => {
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + ttlSeconds * 1000,
    );
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ttlSeconds * 1000);
  };

  beforeEach(async () => {
    (argon.hash as jest.Mock)
      .mockReset()
      .mockResolvedValue(PASSWORD_HASH)
      .mockResolvedValueOnce(DUMMY_HASH);
    (argon.verify as jest.Mock).mockReset().mockResolvedValue(true);

    usersClient = {
      createUser: jest.fn().mockReturnValue(of(usersResponse())),
      deleteUser: jest.fn().mockReturnValue(of({ deleted: true })),
      getUserAuthInfo: jest.fn().mockReturnValue(of(authInfoResponse())),
    };
    accessClient = {
      createOpaqueToken: jest.fn().mockReturnValue(of(tokenResponse)),
      revokeToken: jest.fn().mockReturnValue(of({ revoked: true })),
    };
    loginAttempts = {
      reserveAttempt: jest.fn().mockResolvedValue(1),
      recordFailure: jest.fn().mockResolvedValue({
        locked: false,
        lockSeconds: 0,
        remainingAttempts: 4,
      }),
      reset: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      credential: {
        create: jest.fn().mockResolvedValue({ userId: 'x', email: dto.email }),
        delete: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          userId: CREDENTIAL_USER_ID,
          passwordHash: PASSWORD_HASH,
        }),
      },
      session: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(sessionRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: 'USERS_SERVICE', useValue: clientGrpcFor(usersClient) },
        { provide: 'ACCESS_SERVICE', useValue: clientGrpcFor(accessClient) },
        { provide: PrismaService, useValue: prisma },
        { provide: LoginAttemptService, useValue: loginAttempts },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    await service.onModuleInit();
  });

  // ---Amaç: açılışta üretilen sahte hash'i doğrulamak ---
  describe('onModuleInit', () => {
    it('sahte hash rastgele 32 baytlik bir parolayla uretilir', () => {
      const [randomPassword] = (argon.hash as jest.Mock).mock.calls[0];
      expect(randomPassword).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ---Amaç: kaydın mutlu yolunu doğrulamak ---
  describe('register - basarili akis', () => {
    it('proto TokenResponse sozlesmesindeki tum alanlari doldurur', async () => {
      const response = await service.register(dto);

      expect(response.accessToken).toBe(tokenResponse.opaqueToken);
      expect(response.tokenType).toBe('Bearer');
      expect(response.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(response.refreshToken).toBeTruthy();
      expect(response.userId).toMatch(UUID_V4);
      expect(response.clinicId).toBe('');
    });

    it('users kaydini kendi urettigi UUID v4 ile acar', async () => {
      const response = await service.register(dto);

      const [payload] = usersClient.createUser.mock.calls[0];
      expect(payload.id).toMatch(UUID_V4);
      expect(payload.id).toBe(response.userId);
    });

    it('users cagrisina yalnizca sozlesmedeki alanlari gonderir', async () => {
      await service.register(dto);

      const [payload] = usersClient.createUser.mock.calls[0];
      expect(payload).toEqual({
        id: expect.any(String),
        email: dto.email,
        fullName: dto.fullName,
        phone: dto.phone,
      });
    });

    it('users yanitindaki userId degil, kendi urettigi userId kullanilir', async () => {
      const response = await service.register(dto);

      expect(response.userId).not.toBe('users-tarafindan-dondurulen');
    });

    it('parolayi hashler ve duz metni hicbir yere yazmaz', async () => {
      await service.register(dto);

      expect(argon.hash).toHaveBeenCalledWith(dto.password);
      const [{ data }] = prisma.credential.create.mock.calls[0];
      expect(data.passwordHash).toBe(PASSWORD_HASH);
      expect(JSON.stringify(data)).not.toContain(dto.password);
    });

    it('credential ve session ayni transaction icinde yazilir', async () => {
      await service.register(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.credential.create).toHaveBeenCalledTimes(1);
      expect(prisma.session.create).toHaveBeenCalledTimes(1);
    });

    it('oturum yeni bir aile ile, beni hatirla kapali ve 12 saatlik acilir', async () => {
      const before = Date.now();
      const response = await service.register(dto);
      const after = Date.now();

      const [{ data }] = prisma.session.create.mock.calls[0];
      expect(data.familyId).toMatch(UUID_V4);
      expect(data.rememberMe).toBe(false);
      expect(data.clientType).toBe('WEB');
      expect(data.refreshTokenHash).toBe(sha256(response.refreshToken));
      expectExpiresWithin(
        data.expiresAt,
        before,
        after,
        REFRESH_TOKEN_TTL_SECONDS,
      );
    });

    it('MOBILE istegi veritabani karsiligiyla yazilir', async () => {
      await service.register({ ...dto, clientType: auth.ClientType.MOBILE });

      const [{ data }] = prisma.session.create.mock.calls[0];
      expect(data.clientType).toBe('MOBILE');
    });

    it('her cagride farkli refresh token ve aile uretilir', async () => {
      const first = await service.register(dto);
      const second = await service.register(dto);

      expect(first.refreshToken).not.toBe(second.refreshToken);
      expect(prisma.session.create.mock.calls[0][0].data.familyId).not.toBe(
        prisma.session.create.mock.calls[1][0].data.familyId,
      );
    });

    it('access cagrisina rol, klinik ve access token omru gonderilir', async () => {
      await service.register(dto);

      const [payload] = accessClient.createOpaqueToken.mock.calls[0];
      expect(payload).toEqual({
        userId: expect.stringMatching(UUID_V4),
        role: 'PET_OWNER',
        clinicId: '',
        clientType: auth.ClientType.WEB,
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      });
    });

    it('users yanitindaki clinicId access cagrisina tasinir', async () => {
      usersClient.createUser.mockReturnValue(
        of(
          usersResponse({
            role: users.UserRole.CLINIC,
            clinicId: CLINIC_ID,
          }),
        ),
      );

      await service.register(dto);

      const [payload] = accessClient.createOpaqueToken.mock.calls[0];
      expect(payload.role).toBe('CLINIC');
      expect(payload.clinicId).toBe(CLINIC_ID);
    });

    it('sira: once users, sonra auth veritabani, en son access', async () => {
      await service.register(dto);

      expect(usersClient.createUser.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        accessClient.createOpaqueToken.mock.invocationCallOrder[0],
      );
    });

    it('basarili akista hicbir telafi calismaz', async () => {
      await service.register(dto);

      expect(usersClient.deleteUser).not.toHaveBeenCalled();
      expect(prisma.credential.delete).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: users adımındaki hataları ve telafiyi doğrulamak ---
  describe('register - users adimi basarisiz', () => {
    it('UNAVAILABLE ise kayit olusmadigi icin telafi calismaz', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(usersClient.deleteUser).not.toHaveBeenCalled();
    });

    it('ALREADY_EXISTS ise users hicbir sey yazmadigi icin telafi calismaz', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(
            status.ALREADY_EXISTS,
            ResponseMessages.EMAIL_ALREADY_EXISTS,
          ),
        ),
      );

      await service.register(dto).catch(() => undefined);

      expect(usersClient.deleteUser).not.toHaveBeenCalled();
    });

    it('DEADLINE_EXCEEDED ise kayit olusmus olabilir, telafi calisir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.DEADLINE_EXCEEDED)),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(usersClient.deleteUser).toHaveBeenCalledWith({
        userId: expect.stringMatching(UUID_V4),
      });
    });

    it('INTERNAL ise telafi calisir ve INTERNAL_SERVER_ERROR doner', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.INTERNAL)),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('EMAIL_ALREADY_EXISTS istemciye oldugu gibi tasinir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(
            status.ALREADY_EXISTS,
            ResponseMessages.EMAIL_ALREADY_EXISTS,
          ),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.EMAIL_ALREADY_EXISTS);
    });

    it('PHONE_ALREADY_EXISTS istemciye sizdirilmaz, INTERNAL_SERVER_ERROR doner', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(
            status.ALREADY_EXISTS,
            ResponseMessages.PHONE_ALREADY_EXISTS,
          ),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it('users dogrulama mesaji istemciye sizdirilmaz', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(status.INVALID_ARGUMENT, 'PHONE_WRONG DATA FORMAT'),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it('users adimi basarisizsa auth veritabanina ve access a gidilmez', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.INTERNAL)),
      );

      await service.register(dto).catch(() => undefined);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });

    it('telafi cagrisi da patlarsa asil hata istemciye ulasir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.DEADLINE_EXCEEDED)),
      );
      usersClient.deleteUser.mockReturnValue(
        throwError(() => new Error('users kapali')),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });
  });

  // ---Amaç: users'tan beklenmeyen yanıt geldiğinde telafiyi doğrulamak ---
  describe('register - users yaniti gecersiz', () => {
    it('user alani bossa telafi calisir ve INTERNAL_SERVER_ERROR atar', async () => {
      usersClient.createUser.mockReturnValue(of({ user: undefined }));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rol beyaz listede yoksa telafi calisir ve INTERNAL_SERVER_ERROR atar', async () => {
      usersClient.createUser.mockReturnValue(
        of(usersResponse({ role: users.UserRole.USER_ROLE_UNSPECIFIED })),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });
  });

  // ---Amaç: auth veritabanı adımındaki hataları doğrulamak ---
  describe('register - auth veritabani adimi basarisiz', () => {
    it('email cakismasinda EMAIL_ALREADY_EXISTS atar ve users kaydi silinir', async () => {
      prisma.credential.create.mockRejectedValue(prismaError('P2002'));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.EMAIL_ALREADY_EXISTS);
      expect(usersClient.deleteUser).toHaveBeenCalledWith({
        userId: expect.stringMatching(UUID_V4),
      });
    });

    it('session FK ihlali yukari tasinir ve users kaydi silinir', async () => {
      const original = prismaError('P2003');
      prisma.session.create.mockRejectedValue(original);

      await expect(service.register(dto)).rejects.toBe(original);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('gecersiz clientType INVALID_CLIENT_TYPE ile reddedilir ve users kaydi silinir', async () => {
      const error = await service
        .register({
          ...dto,
          clientType: auth.ClientType.CLIENT_TYPE_UNSPECIFIED,
        })
        .catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INVALID_CLIENT_TYPE);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('veritabani adimi basarisizsa access cagrilmaz', async () => {
      prisma.credential.create.mockRejectedValue(prismaError('P2002'));

      await service.register(dto).catch(() => undefined);

      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: access adımı başarısız olduğunda iki yönlü telafiyi doğrulamak ---
  describe('register - access adimi basarisiz', () => {
    beforeEach(() =>
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      ),
    );

    it('SERVICE_UNAVAILABLE atar', async () => {
      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('once credential, sonra users kaydi silinir', async () => {
      await service.register(dto).catch(() => undefined);

      expect(prisma.credential.delete).toHaveBeenCalledWith({
        where: { userId: expect.stringMatching(UUID_V4) },
      });
      expect(prisma.credential.delete.mock.invocationCallOrder[0]).toBeLessThan(
        usersClient.deleteUser.mock.invocationCallOrder[0],
      );
    });

    it('her iki telafi de patlarsa asil hata korunur', async () => {
      prisma.credential.delete.mockRejectedValue(new Error('silinemedi'));
      usersClient.deleteUser.mockReturnValue(
        throwError(() => new Error('users kapali')),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('access hata mesaji istemciye sizdirilmaz', async () => {
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() =>
          grpcError(status.INVALID_ARGUMENT, 'CLINIC_ID_WRONG DATA FORMAT'),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });
  });

  // ---Amaç: girişin mutlu yolunu doğrulamak ---
  describe('login - basarili akis', () => {
    it('proto TokenResponse sozlesmesindeki tum alanlari doldurur', async () => {
      await expect(service.login(loginDto)).resolves.toEqual({
        accessToken: tokenResponse.opaqueToken,
        refreshToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        userId: CREDENTIAL_USER_ID,
        clinicId: '',
        refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      });
    });

    it('klinik hesabinda clinicId yanita eklenir', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        of(
          authInfoResponse({
            role: users.UserRole.CLINIC,
            clinicId: CLINIC_ID,
          }),
        ),
      );

      await expect(service.login(loginDto)).resolves.toMatchObject({
        clinicId: CLINIC_ID,
      });
    });

    it('sifre kayitli hash ile dogrulanir ve deneme sayaci sifirlanir', async () => {
      await service.login(loginDto);

      expect(argon.verify).toHaveBeenCalledWith(
        PASSWORD_HASH,
        loginDto.password,
      );
      expect(loginAttempts.reset).toHaveBeenCalledWith(loginDto.email);
      expect(loginAttempts.recordFailure).not.toHaveBeenCalled();
    });

    it('access cagrisina rol, klinik ve access token omru gonderilir', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        of(
          authInfoResponse({
            role: users.UserRole.CLINIC,
            clinicId: CLINIC_ID,
          }),
        ),
      );

      await service.login(loginDto);

      expect(accessClient.createOpaqueToken).toHaveBeenCalledWith({
        userId: CREDENTIAL_USER_ID,
        role: 'CLINIC',
        clinicId: CLINIC_ID,
        clientType: auth.ClientType.WEB,
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      });
    });

    it('her giris yeni bir aile acar ve transaction kullanmaz', async () => {
      const response = await service.login(loginDto);

      const [{ data }] = prisma.session.create.mock.calls[0];
      expect(data.familyId).toMatch(UUID_V4);
      expect(data.userId).toBe(CREDENTIAL_USER_ID);
      expect(data.refreshTokenHash).toBe(sha256(response.refreshToken));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['isaretsiz', false, false, REFRESH_TOKEN_TTL_SECONDS],
      ['gonderilmemis', undefined, false, REFRESH_TOKEN_TTL_SECONDS],
      ['isaretli', true, true, REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS],
    ])(
      'oturumu hatirla %s ise sure ve kayit dogru ayarlanir',
      async (_label, rememberMe, stored, ttlSeconds) => {
        const before = Date.now();
        const response = await service.login({
          ...loginDto,
          rememberMe: rememberMe as boolean,
        });
        const after = Date.now();

        const [{ data }] = prisma.session.create.mock.calls[0];
        expect(Boolean(data.rememberMe)).toBe(stored);
        expectExpiresWithin(data.expiresAt, before, after, ttlSeconds);
        expect(response.refreshExpiresIn).toBe(ttlSeconds);
      },
    );

    it('sira: deneme rezervasyonu, sifre, sayac sifirlama, users, access, oturum', async () => {
      await service.login(loginDto);

      const order = [
        loginAttempts.reserveAttempt.mock.invocationCallOrder[0],
        prisma.credential.findUnique.mock.invocationCallOrder[0],
        (argon.verify as jest.Mock).mock.invocationCallOrder[0],
        loginAttempts.reset.mock.invocationCallOrder[0],
        usersClient.getUserAuthInfo.mock.invocationCallOrder[0],
        accessClient.createOpaqueToken.mock.invocationCallOrder[0],
        prisma.session.create.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  // ---Amaç: kimlik doğrulama hatalarını ve email sızıntısı korumasını doğrulamak ---
  describe('login - kimlik dogrulama basarisiz', () => {
    it('deneme siniri asildiysa veritabanina ve argon2 ye gidilmez', async () => {
      loginAttempts.reserveAttempt.mockRejectedValue(
        new RpcException(ResponseMessages.TOO_MANY_REQUESTS),
      );

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.TOO_MANY_REQUESTS);
      expect(prisma.credential.findUnique).not.toHaveBeenCalled();
      expect(argon.verify).not.toHaveBeenCalled();
    });

    it('yanlis sifrede hata rezervasyon numarasiyla kaydedilir', async () => {
      loginAttempts.reserveAttempt.mockResolvedValue(4);
      (argon.verify as jest.Mock).mockResolvedValue(false);

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.PASSWORD_OR_EMAIL_WRONG);
      expect(loginAttempts.recordFailure).toHaveBeenCalledWith(
        loginDto.email,
        4,
      );
      expect(loginAttempts.reset).not.toHaveBeenCalled();
    });

    it('kayitsiz email de sahte hash ile argon2 dogrulamasindan gecer', async () => {
      prisma.credential.findUnique.mockResolvedValue(null);
      (argon.verify as jest.Mock).mockResolvedValue(false);

      const error = await service.login(loginDto).catch((e) => e);

      expect(argon.verify).toHaveBeenCalledWith(DUMMY_HASH, loginDto.password);
      expect(error.message).toBe(ResponseMessages.PASSWORD_OR_EMAIL_WRONG);
    });

    it('sahte hash dogrulansa bile kayitsiz email ile giris yapilamaz', async () => {
      prisma.credential.findUnique.mockResolvedValue(null);

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.PASSWORD_OR_EMAIL_WRONG);
      expect(usersClient.getUserAuthInfo).not.toHaveBeenCalled();
    });

    it('kayitli ve kayitsiz email disaridan ayirt edilemez', async () => {
      (argon.verify as jest.Mock).mockResolvedValue(false);
      const wrongPassword = await service.login(loginDto).catch((e) => e);
      prisma.credential.findUnique.mockResolvedValue(null);
      const unknownEmail = await service.login(loginDto).catch((e) => e);

      expect(unknownEmail.message).toBe(wrongPassword.message);
      expect(argon.verify).toHaveBeenCalledTimes(2);
      expect(loginAttempts.recordFailure).toHaveBeenCalledTimes(2);
    });
  });

  // ---Amaç: giriş sonrası dış servis hatalarını doğrulamak ---
  describe('login - users, access ve oturum adimlari basarisiz', () => {
    it('pasif hesapta ACCOUNT_DISABLED tasinir, token uretilmez', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        throwError(() =>
          grpcError(
            status.PERMISSION_DENIED,
            ResponseMessages.ACCOUNT_DISABLED,
          ),
        ),
      );

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.ACCOUNT_DISABLED);
      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('credential var ama users kaydi yoksa INTERNAL_SERVER_ERROR doner', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        throwError(() =>
          grpcError(status.NOT_FOUND, ResponseMessages.NOT_FOUND),
        ),
      );

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it.each([status.DEADLINE_EXCEEDED, status.UNAVAILABLE])(
      'users gRPC kodu %s ise SERVICE_UNAVAILABLE doner',
      async (code) => {
        usersClient.getUserAuthInfo.mockReturnValue(
          throwError(() => grpcError(code)),
        );

        const error = await service.login(loginDto).catch((e) => e);

        expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      },
    );

    it('access kapaliysa SERVICE_UNAVAILABLE doner ve oturum yazilmaz', async () => {
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      const error = await service.login(loginDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(prisma.session.create).not.toHaveBeenCalled();
      expect(accessClient.revokeToken).not.toHaveBeenCalled();
    });

    it('oturum yazilamazsa access token iptal edilir ve asil hata tasinir', async () => {
      const original = new Error('veritabani kapali');
      prisma.session.create.mockRejectedValue(original);

      await expect(service.login(loginDto)).rejects.toBe(original);
      expect(accessClient.revokeToken).toHaveBeenCalledWith({
        opaqueToken: tokenResponse.opaqueToken,
      });
    });

    it('iptal cagrisi da patlarsa asil hata korunur', async () => {
      const original = new Error('veritabani kapali');
      prisma.session.create.mockRejectedValue(original);
      accessClient.revokeToken.mockReturnValue(
        throwError(() => new Error('access kapali')),
      );

      await expect(service.login(loginDto)).rejects.toBe(original);
    });
  });

  // ---Amaç: refresh token rotation'ın mutlu yolunu doğrulamak ---
  describe('refreshToken - basarili akis', () => {
    it('yeni token cifti doner, userId oturumdan gelir', async () => {
      await expect(service.refreshToken(refreshDto)).resolves.toEqual({
        accessToken: tokenResponse.opaqueToken,
        refreshToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        userId: CREDENTIAL_USER_ID,
        clinicId: '',
        refreshExpiresIn: REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS,
      });
    });

    it('klinik hesabinda clinicId yanita eklenir', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        of(
          authInfoResponse({
            role: users.UserRole.CLINIC,
            clinicId: CLINIC_ID,
          }),
        ),
      );

      await expect(service.refreshToken(refreshDto)).resolves.toMatchObject({
        clinicId: CLINIC_ID,
      });
    });

    it('oturum refresh token in hash i ile aranir', async () => {
      await service.refreshToken(refreshDto);

      expect(prisma.session.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { refreshTokenHash: sha256(REFRESH_TOKEN) },
        }),
      );
    });

    it('eski oturum yalnizca hala gecerliyse atomik olarak iptal edilir', async () => {
      await service.refreshToken(refreshDto);

      const [{ where, data }] = prisma.session.updateMany.mock.calls[0];
      expect(where).toEqual({
        refreshTokenHash: sha256(REFRESH_TOKEN),
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      });
      expect(data.revokedAt).toBeInstanceOf(Date);
    });

    it('ailenin daha eski iptal edilmis satirlari silinir (en fazla 2 satir)', async () => {
      await service.refreshToken(refreshDto);

      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: {
          familyId: FAMILY_ID,
          refreshTokenHash: { not: sha256(REFRESH_TOKEN) },
          revokedAt: { not: null },
        },
      });
    });

    it('yeni oturum ayni aileyi, turu ve beni hatirla secimini devralir', async () => {
      const before = Date.now();
      const response = await service.refreshToken(refreshDto);
      const after = Date.now();

      const [{ data }] = prisma.session.create.mock.calls[0];
      expect(data).toMatchObject({
        userId: CREDENTIAL_USER_ID,
        familyId: FAMILY_ID,
        clientType: 'WEB',
        rememberMe: true,
        refreshTokenHash: sha256(response.refreshToken),
      });
      expectExpiresWithin(
        data.expiresAt,
        before,
        after,
        REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS,
      );
    });

    it('iptal, eski satir silme ve yeni oturum tek transaction icinde', async () => {
      await service.refreshToken(refreshDto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const txOrder = prisma.$transaction.mock.invocationCallOrder[0];
      for (const step of [
        prisma.session.updateMany,
        prisma.session.deleteMany,
        prisma.session.create,
      ]) {
        expect(step.mock.invocationCallOrder[0]).toBeGreaterThan(txOrder);
      }
    });

    it('users bilgisi oturumdaki userId ile taze alinir', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        of(
          authInfoResponse({
            role: users.UserRole.CLINIC,
            clinicId: CLINIC_ID,
          }),
        ),
      );

      await service.refreshToken(refreshDto);

      expect(usersClient.getUserAuthInfo).toHaveBeenCalledWith({
        userId: CREDENTIAL_USER_ID,
      });
      expect(accessClient.createOpaqueToken).toHaveBeenCalledWith({
        userId: CREDENTIAL_USER_ID,
        role: 'CLINIC',
        clinicId: CLINIC_ID,
        clientType: auth.ClientType.WEB,
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      });
    });
  });

  // ---Amaç: geçersiz refresh token'ın her nedeninin 401 olduğunu doğrulamak ---
  describe('refreshToken - gecersiz token', () => {
    it('oturum bulunamazsa UNAUTH, users ve access e gidilmez', async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(usersClient.getUserAuthInfo).not.toHaveBeenCalled();
      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });

    it('oturumun suresi dolmussa UNAUTH', async () => {
      prisma.session.findUnique.mockResolvedValue(
        sessionRow({ expiresAt: new Date(Date.now() - 1000) }),
      );

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('clientType oturumdakiyle uyusmazsa UNAUTH', async () => {
      const error = await service
        .refreshToken({ ...refreshDto, clientType: auth.ClientType.MOBILE })
        .catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });

    it('iptal edilmis token tolerans icinde gelirse yaris sayilir, aile iptal edilmez', async () => {
      prisma.session.findUnique.mockResolvedValue(
        sessionRow({
          revokedAt: new Date(
            Date.now() - (REFRESH_REUSE_TOLERANCE_SECONDS - 5) * 1000,
          ),
        }),
      );

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('iptal edilmis token tolerans disinda gelirse hirsizlik sayilir, aile iptal edilir', async () => {
      prisma.session.findUnique.mockResolvedValue(
        sessionRow({
          revokedAt: new Date(
            Date.now() - (REFRESH_REUSE_TOLERANCE_SECONDS + 1) * 1000,
          ),
        }),
      );

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });

    it('esZamanli yenilemeyi kaybeden istek UNAUTH alir, urettigi access token iptal edilir', async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 0 });

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(prisma.session.create).not.toHaveBeenCalled();
      expect(accessClient.revokeToken).toHaveBeenCalledWith({
        opaqueToken: tokenResponse.opaqueToken,
      });
    });
  });

  // ---Amaç: token doğrulandıktan sonraki hataların 401'e çevrilmediğini doğrulamak ---
  describe('refreshToken - dogrulama sonrasi hatalar', () => {
    it('pasif hesap ACCOUNT_DISABLED alir, oturum dondurulmez', async () => {
      usersClient.getUserAuthInfo.mockReturnValue(
        throwError(() =>
          grpcError(
            status.PERMISSION_DENIED,
            ResponseMessages.ACCOUNT_DISABLED,
          ),
        ),
      );

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.ACCOUNT_DISABLED);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('access kapaliysa SERVICE_UNAVAILABLE, eski oturum iptal edilmez', async () => {
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      const error = await service.refreshToken(refreshDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('yeni oturum yazilamazsa hata tasinir ve access token iptal edilir', async () => {
      const original = new Error('veritabani kapali');
      prisma.session.create.mockRejectedValue(original);

      await expect(service.refreshToken(refreshDto)).rejects.toBe(original);
      expect(accessClient.revokeToken).toHaveBeenCalledTimes(1);
    });
  });

  // ---Amaç: çıkışın oturum ailesini silip access token'ı iptal ettiğini doğrulamak ---
  describe('logout', () => {
    it('oturumun ailesi silinir, access token iptal edilir ve basari doner', async () => {
      prisma.session.findUnique.mockResolvedValue({ familyId: FAMILY_ID });

      await expect(service.logout(logoutDto)).resolves.toEqual({
        success: true,
      });
      expect(prisma.session.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { refreshTokenHash: sha256(REFRESH_TOKEN) },
        }),
      );
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { familyId: FAMILY_ID },
      });
      expect(accessClient.revokeToken).toHaveBeenCalledWith({
        opaqueToken: logoutDto.opaqueToken,
      });
    });

    it('opaque token gonderilmezse yalnizca oturum kapanir', async () => {
      prisma.session.findUnique.mockResolvedValue({ familyId: FAMILY_ID });

      await expect(
        service.logout({ refreshToken: REFRESH_TOKEN } as auth.LogoutRequest),
      ).resolves.toEqual({ success: true });
      expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
      expect(accessClient.revokeToken).not.toHaveBeenCalled();
    });

    it('oturum bulunamazsa UNAUTH, hicbir satir silinmez (toplu silme korumasi)', async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      const error = await service.logout(logoutDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
      expect(accessClient.revokeToken).not.toHaveBeenCalled();
    });

    it('esZamanli logout ta silinecek satir kalmadiysa UNAUTH', async () => {
      prisma.session.findUnique.mockResolvedValue({ familyId: FAMILY_ID });
      prisma.session.deleteMany.mockResolvedValue({ count: 0 });

      const error = await service.logout(logoutDto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.UNAUTH);
      expect(accessClient.revokeToken).not.toHaveBeenCalled();
    });

    it('access token iptali basarisiz olsa da cikis tamamlanir', async () => {
      prisma.session.findUnique.mockResolvedValue({ familyId: FAMILY_ID });
      accessClient.revokeToken.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      await expect(service.logout(logoutDto)).resolves.toEqual({
        success: true,
      });
    });
  });

  // ---Amaç: register telafisinde kullanılan credential silme yardımcısını doğrulamak ---
  describe('deleteInCredential', () => {
    const userId = CREDENTIAL_USER_ID;
    const deleteInCredential = (data: { userId: string }) =>
      service['deleteInCredential'](data);

    it('kaydi siler ve deleted true doner', async () => {
      await expect(deleteInCredential({ userId })).resolves.toEqual({
        deleted: true,
      });
      expect(prisma.credential.delete).toHaveBeenCalledWith({
        where: { userId },
      });
    });

    it('kayit yoksa deleted false doner ve hata atmaz', async () => {
      prisma.credential.delete.mockRejectedValue(prismaError('P2025'));

      await expect(deleteInCredential({ userId })).resolves.toEqual({
        deleted: false,
      });
    });

    it('userId bossa BAD_REQUEST atar ve veritabanina gitmez', async () => {
      const error = await deleteInCredential({ userId: '' }).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
      expect(prisma.credential.delete).not.toHaveBeenCalled();
    });

    it('userId uuid formatinda degilse BAD_REQUEST atar', async () => {
      prisma.credential.delete.mockRejectedValue(prismaError('P2007'));

      const error = await deleteInCredential({ userId: 'uuid-degil' }).catch(
        (e) => e,
      );

      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
    });

    it('beklenmeyen Prisma hatasini oldugu gibi yukari tasir', async () => {
      const original = prismaError('P2021');
      prisma.credential.delete.mockRejectedValue(original);

      await expect(deleteInCredential({ userId })).rejects.toBe(original);
    });
  });
});
