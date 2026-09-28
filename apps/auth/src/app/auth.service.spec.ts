jest.mock('argon2', () => ({ hash: jest.fn() }));

jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
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
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants';
import { Prisma } from '../generated/prisma/client';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$hash';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('test hatasi', {
    code,
    clientVersion: 'test',
  });

const grpcError = (code: number, details?: string) =>
  Object.assign(new Error(details ?? 'grpc hatasi'), { code, details });

describe('AuthService', () => {
  let service: AuthService;
  let usersClient: { createUser: jest.Mock; deleteUser: jest.Mock };
  let accessClient: { createOpaqueToken: jest.Mock; revokeToken: jest.Mock };
  let tx: {
    credential: { create: jest.Mock };
    session: { create: jest.Mock };
  };
  let prisma: {
    credential: { create: jest.Mock; delete: jest.Mock };
    session: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  const dto: auth.RegisterRequest = {
    email: 'ali@example.com',
    password: 'Sifre123!',
    fullName: 'Ali Veli',
    phone: '+905551234567',
    clientType: auth.ClientType.WEB,
  };

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

  const tokenResponse: access.CreateTokenResponse = {
    opaqueToken: 'opaque-abc-123',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:15:00.000Z',
  };

  const clientGrpcFor = (implementation: unknown): ClientGrpc =>
    ({ getService: () => implementation }) as unknown as ClientGrpc;

  beforeEach(async () => {
    (argon.hash as jest.Mock).mockResolvedValue(PASSWORD_HASH);

    usersClient = {
      createUser: jest.fn().mockReturnValue(of(usersResponse())),
      deleteUser: jest.fn().mockReturnValue(of({ deleted: true })),
    };
    accessClient = {
      createOpaqueToken: jest.fn().mockReturnValue(of(tokenResponse)),
      revokeToken: jest.fn().mockReturnValue(of({ revoked: true })),
    };

    tx = {
      credential: {
        create: jest.fn().mockResolvedValue({ userId: 'x', email: dto.email }),
      },
      session: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      credential: {
        create: tx.credential.create,
        delete: jest.fn().mockResolvedValue({}),
      },
      session: { create: tx.session.create },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: 'USERS_SERVICE', useValue: clientGrpcFor(usersClient) },
        { provide: 'ACCESS_SERVICE', useValue: clientGrpcFor(accessClient) },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    service.onModuleInit();
  });

  describe('register - basarili akis', () => {
    it('proto TokenResponse sozlesmesindeki tum alanlari doldurur', async () => {
      const response = await service.register(dto);

      expect(response.accessToken).toBe(tokenResponse.opaqueToken);
      expect(response.tokenType).toBe('Bearer');
      expect(response.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(response.refreshToken).toBeTruthy();
      expect(response.userId).toMatch(UUID_V4);
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
      expect(payload).not.toHaveProperty('password');
      expect(payload).not.toHaveProperty('clientType');
    });

    it('users yanitindaki userId degil, kendi urettigi userId kullanilir', async () => {
      const response = await service.register(dto);

      expect(response.userId).not.toBe('users-tarafindan-dondurulen');
    });

    it('parolayi hashler ve duz metni hicbir yere yazmaz', async () => {
      await service.register(dto);

      expect(argon.hash).toHaveBeenCalledWith(dto.password);

      const [{ data }] = tx.credential.create.mock.calls[0];
      expect(data.passwordHash).toBe(PASSWORD_HASH);
      expect(JSON.stringify(data)).not.toContain(dto.password);
    });

    it('credential kaydini userId ve email ile acar', async () => {
      await service.register(dto);

      const [{ data }] = tx.credential.create.mock.calls[0];
      expect(data.userId).toMatch(UUID_V4);
      expect(data.email).toBe(dto.email);
    });

    it('credential ve session ayni transaction icinde yazilir', async () => {
      await service.register(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.credential.create).toHaveBeenCalledTimes(1);
      expect(tx.session.create).toHaveBeenCalledTimes(1);
    });

    it('refresh token duz metin degil sha256 ozeti olarak saklanir', async () => {
      const response = await service.register(dto);

      const [{ data }] = tx.session.create.mock.calls[0];
      const expected = createHash('sha256')
        .update(response.refreshToken)
        .digest('hex');

      expect(data.refreshTokenHash).toBe(expected);
      expect(data.refreshTokenHash).not.toBe(response.refreshToken);
    });

    it('session kaydina clientType veritabani karsiligiyla yazilir', async () => {
      await service.register(dto);

      const [{ data }] = tx.session.create.mock.calls[0];
      expect(data.clientType).toBe('WEB');
    });

    it('MOBILE istegi de veritabani karsiligiyla yazilir', async () => {
      await service.register({ ...dto, clientType: auth.ClientType.MOBILE });

      const [{ data }] = tx.session.create.mock.calls[0];
      expect(data.clientType).toBe('MOBILE');
    });

    it('refresh token omru 12 saat olarak ayarlanir', async () => {
      const before = Date.now();
      await service.register(dto);
      const after = Date.now();

      const [{ data }] = tx.session.create.mock.calls[0];
      const expiresAt = (data.expiresAt as Date).getTime();

      expect(expiresAt).toBeGreaterThanOrEqual(
        before + REFRESH_TOKEN_TTL_SECONDS * 1000,
      );
      expect(expiresAt).toBeLessThanOrEqual(
        after + REFRESH_TOKEN_TTL_SECONDS * 1000,
      );
    });

    it('her cagride farkli refresh token uretilir', async () => {
      const first = await service.register(dto);
      const second = await service.register(dto);

      expect(first.refreshToken).not.toBe(second.refreshToken);
      expect(first.userId).not.toBe(second.userId);
    });

    it('access cagrisina rol, klinik ve bos scope listesi gonderilir', async () => {
      await service.register(dto);

      const [payload] = accessClient.createOpaqueToken.mock.calls[0];
      expect(payload).toEqual({
        userId: expect.stringMatching(UUID_V4),
        role: 'PET_OWNER',
        clinicId: '',
        clientType: auth.ClientType.WEB,
        scopes: [],
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      });
    });

    it('users yanitindaki clinicId access cagrisina tasinir', async () => {
      usersClient.createUser.mockReturnValue(
        of(
          usersResponse({
            role: users.UserRole.VETERINARIAN,
            clinicId: '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718',
          }),
        ),
      );

      await service.register(dto);

      const [payload] = accessClient.createOpaqueToken.mock.calls[0];
      expect(payload.role).toBe('VETERINARIAN');
      expect(payload.clinicId).toBe('6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718');
    });

    it('sira: once users, sonra auth veritabani, en son access', async () => {
      await service.register(dto);

      const usersOrder = usersClient.createUser.mock.invocationCallOrder[0];
      const txOrder = prisma.$transaction.mock.invocationCallOrder[0];
      const accessOrder =
        accessClient.createOpaqueToken.mock.invocationCallOrder[0];

      expect(usersOrder).toBeLessThan(txOrder);
      expect(txOrder).toBeLessThan(accessOrder);
    });

    it('basarili akista hicbir telafi calismaz', async () => {
      await service.register(dto);

      expect(usersClient.deleteUser).not.toHaveBeenCalled();
      expect(prisma.credential.delete).not.toHaveBeenCalled();
    });
  });

  describe('register - users adimi basarisiz', () => {
    it('UNAVAILABLE ise kayit hic olusmadigi icin telafi calismaz', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
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

    it('INTERNAL ise kayit olusmus olabilir, telafi calisir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() => grpcError(status.INTERNAL)),
      );

      await service.register(dto).catch(() => undefined);

      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('is kurali hatasi istemciye oldugu gibi tasinir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(
            status.ALREADY_EXISTS,
            ResponseMessages.EMAIL_ALREADY_EXISTS,
          ),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.EMAIL_ALREADY_EXISTS);
    });

    it('dogrulama mesaji onekiyle birlikte tasinir', async () => {
      usersClient.createUser.mockReturnValue(
        throwError(() =>
          grpcError(status.INVALID_ARGUMENT, 'PHONE_WRONG DATA FORMAT'),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe('PHONE_WRONG DATA FORMAT');
    });

    it('users adimi basarisizsa auth veritabanina hicbir sey yazilmaz', async () => {
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
        throwError(() => new Error('users servisi de kapali')),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });
  });

  describe('register - users yaniti gecersiz', () => {
    it('user alani bossa telafi calisir ve INTERNAL_SERVER_ERROR atar', async () => {
      usersClient.createUser.mockReturnValue(of({ user: undefined }));

      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('rol beyaz listede yoksa telafi calisir ve INTERNAL_SERVER_ERROR atar', async () => {
      usersClient.createUser.mockReturnValue(
        of(usersResponse({ role: users.UserRole.USER_ROLE_UNSPECIFIED })),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('gecersiz yanitta auth veritabanina yazilmaz', async () => {
      usersClient.createUser.mockReturnValue(of({ user: undefined }));

      await service.register(dto).catch(() => undefined);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('register - auth veritabani adimi basarisiz', () => {
    it('email cakismasinda EMAIL_ALREADY_EXISTS atar ve users kaydi silinir', async () => {
      tx.credential.create.mockRejectedValue(prismaError('P2002'));

      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.EMAIL_ALREADY_EXISTS);
      expect(usersClient.deleteUser).toHaveBeenCalledWith({
        userId: expect.stringMatching(UUID_V4),
      });
    });

    it('session FK ihlalinde INTERNAL_SERVER_ERROR atar', async () => {
      tx.session.create.mockRejectedValue(prismaError('P2003'));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it('ayni clientType icin aktif oturum varsa CONFLICT atar', async () => {
      tx.session.create.mockRejectedValue(prismaError('P2002'));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.CONFLICT);
    });

    it('gecersiz clientType INVALID_CLIENT_TYPE ile reddedilir', async () => {
      const error = await service
        .register({
          ...dto,
          clientType: auth.ClientType.CLIENT_TYPE_UNSPECIFIED,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.INVALID_CLIENT_TYPE);
    });

    it('veritabani adimi basarisizsa access cagrilmaz', async () => {
      tx.credential.create.mockRejectedValue(prismaError('P2002'));

      await service.register(dto).catch(() => undefined);

      expect(accessClient.createOpaqueToken).not.toHaveBeenCalled();
    });

    it('beklenmeyen hata oldugu gibi yukari tasinir', async () => {
      const original = new Error('veritabani kapali');
      tx.credential.create.mockRejectedValue(original);

      await expect(service.register(dto)).rejects.toBe(original);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('register - access adimi basarisiz', () => {
    beforeEach(() =>
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      ),
    );

    it('SERVICE_UNAVAILABLE atar', async () => {
      const error = await service.register(dto).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('credential kaydi silinir, bagli oturumlar cascade ile gider', async () => {
      await service.register(dto).catch(() => undefined);

      expect(prisma.credential.delete).toHaveBeenCalledWith({
        where: { userId: expect.stringMatching(UUID_V4) },
      });
    });

    it('users kaydi da silinir', async () => {
      await service.register(dto).catch(() => undefined);

      expect(usersClient.deleteUser).toHaveBeenCalledWith({
        userId: expect.stringMatching(UUID_V4),
      });
    });

    it('yerel temizlik uzak temizlikten once yapilir', async () => {
      await service.register(dto).catch(() => undefined);

      expect(prisma.credential.delete.mock.invocationCallOrder[0]).toBeLessThan(
        usersClient.deleteUser.mock.invocationCallOrder[0],
      );
    });

    it('credential silme basarisiz olsa bile asil hata istemciye ulasir', async () => {
      prisma.credential.delete.mockRejectedValue(new Error('silinemedi'));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(usersClient.deleteUser).toHaveBeenCalledTimes(1);
    });

    it('silinecek credential yoksa telafi sessizce gecer', async () => {
      prisma.credential.delete.mockRejectedValue(prismaError('P2025'));

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('her iki telafi de patlarsa asil hata korunur', async () => {
      prisma.credential.delete.mockRejectedValue(new Error('silinemedi'));
      usersClient.deleteUser.mockReturnValue(
        throwError(() => new Error('users kapali')),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('access is kurali hatasi oldugu gibi tasinir', async () => {
      accessClient.createOpaqueToken.mockReturnValue(
        throwError(() =>
          grpcError(
            status.INVALID_ARGUMENT,
            ResponseMessages.INVALID_CLIENT_TYPE,
          ),
        ),
      );

      const error = await service.register(dto).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INVALID_CLIENT_TYPE);
    });
  });

  describe('deleteInCredential', () => {
    const userId = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';

    it('kaydi siler ve deleted true doner', async () => {
      await expect(service.deleteInCredential({ userId })).resolves.toEqual({
        deleted: true,
      });
      expect(prisma.credential.delete).toHaveBeenCalledWith({
        where: { userId },
      });
    });

    it('kayit yoksa deleted false doner ve hata atmaz', async () => {
      prisma.credential.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.deleteInCredential({ userId })).resolves.toEqual({
        deleted: false,
      });
    });

    it('ayni userId icin iki kez cagrilabilir', async () => {
      prisma.credential.delete
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(prismaError('P2025'));

      await expect(service.deleteInCredential({ userId })).resolves.toEqual({
        deleted: true,
      });
      await expect(service.deleteInCredential({ userId })).resolves.toEqual({
        deleted: false,
      });
    });

    it('userId bossa BAD_REQUEST atar ve veritabanina gitmez', async () => {
      const error = await service
        .deleteInCredential({ userId: '' })
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
      expect(prisma.credential.delete).not.toHaveBeenCalled();
    });

    it('userId uuid formatinda degilse BAD_REQUEST atar', async () => {
      prisma.credential.delete.mockRejectedValue(prismaError('P2007'));

      const error = await service
        .deleteInCredential({ userId: 'uuid-degil' })
        .catch((e) => e);

      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
    });

    it('beklenmeyen Prisma hatasini oldugu gibi yukari tasir', async () => {
      const original = prismaError('P2021');
      prisma.credential.delete.mockRejectedValue(original);

      await expect(service.deleteInCredential({ userId })).rejects.toBe(
        original,
      );
    });
  });
});
