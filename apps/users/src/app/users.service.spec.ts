jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { users } from '@libs/proto';
import { ResponseMessages } from '@libs/common';
import { UsersService } from './users.service';
import { PrismaService } from './prisma/prisma.service';
import { Prisma, User, UserRole } from '../generated/prisma/client';

const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';

const dbUser = (over: Partial<User> = {}): User => ({
  id: USER_ID,
  email: 'ali@example.com',
  fullName: 'Ali Veli',
  phone: '+905551234567',
  role: UserRole.PET_OWNER,
  clinicId: null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('test hatasi', {
    code,
    clientVersion: 'test',
    meta,
  });

const uniqueViolationMeta = (index: string) => ({
  driverAdapterError: {
    cause: {
      kind: 'UniqueConstraintViolation',
      constraint: { index },
      table: 'users',
    },
  },
  modelName: 'User',
});

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      create: jest.Mock;
      delete: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };

  const createRequest: users.CreateUserRequest = {
    id: USER_ID,
    email: 'ali@example.com',
    fullName: 'Ali Veli',
    phone: '+905551234567',
  };

  beforeEach(async () => {
    prisma = {
      user: {
        create: jest.fn(),
        delete: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'ACCESS_SERVICE', useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  // ---Amaç: kullanıcı satırının oluşturulup proto User'a eksiksiz çevrildiğini doğrulamak ---
  describe('createUser - basarili akis', () => {
    it('proto User sozlesmesindeki tum alanlari doldurur', async () => {
      prisma.user.create.mockResolvedValue(dbUser());

      const response = await service.createUser(createRequest);

      expect(response.user).toEqual({
        userId: USER_ID,
        email: 'ali@example.com',
        fullName: 'Ali Veli',
        phone: '+905551234567',
        role: users.UserRole.PET_OWNER,
        clinicId: '',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    });

    it('yalnizca id, email, fullName ve phone alanlarini yazar', async () => {
      prisma.user.create.mockResolvedValue(dbUser());

      await service.createUser(createRequest);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          id: USER_ID,
          email: 'ali@example.com',
          fullName: 'Ali Veli',
          phone: '+905551234567',
        },
      });
    });

    it('role ve clinicId istekten alinmaz, varsayilani veritabani belirler', async () => {
      prisma.user.create.mockResolvedValue(dbUser());

      await service.createUser(createRequest);

      const [{ data }] = prisma.user.create.mock.calls[0];
      expect(data).not.toHaveProperty('role');
      expect(data).not.toHaveProperty('clinicId');
    });

    it('clinicId dolu olan klinik hesabi kaydini oldugu gibi doner', async () => {
      prisma.user.create.mockResolvedValue(
        dbUser({ role: UserRole.CLINIC, clinicId: CLINIC_ID }),
      );

      const response = await service.createUser(createRequest);

      expect(response.user?.role).toBe(users.UserRole.CLINIC);
      expect(response.user?.clinicId).toBe(CLINIC_ID);
    });

    it.each([
      [UserRole.PET_OWNER, users.UserRole.PET_OWNER],
      [UserRole.CLINIC, users.UserRole.CLINIC],
    ])('%s rolunu proto karsiligina cevirir', async (dbRole, protoRole) => {
      prisma.user.create.mockResolvedValue(dbUser({ role: dbRole }));

      const response = await service.createUser(createRequest);

      expect(response.user?.role).toBe(protoRole);
    });

    it('tarihleri ISO-8601 dizesine cevirir', async () => {
      prisma.user.create.mockResolvedValue(dbUser());

      const response = await service.createUser(createRequest);

      expect(typeof response.user?.createdAt).toBe('string');
      expect(typeof response.user?.updatedAt).toBe('string');
    });
  });

  // ---Amaç: unique ihlallerinin constraint adına göre doğru hata koduna eşlendiğini doğrulamak ---
  describe('createUser - unique ihlalleri', () => {
    it('email cakismasinda EMAIL_ALREADY_EXISTS atar', async () => {
      prisma.user.create.mockRejectedValue(
        prismaError('P2002', uniqueViolationMeta('users_email_key')),
      );

      const error = await service.createUser(createRequest).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.EMAIL_ALREADY_EXISTS);
    });

    it('telefon cakismasinda PHONE_ALREADY_EXISTS atar', async () => {
      prisma.user.create.mockRejectedValue(
        prismaError('P2002', uniqueViolationMeta('users_tel_no_key')),
      );

      const error = await service.createUser(createRequest).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.PHONE_ALREADY_EXISTS);
    });

    it('taninmayan constraint adinda INTERNAL_SERVER_ERROR atar', async () => {
      prisma.user.create.mockRejectedValue(
        prismaError('P2002', uniqueViolationMeta('users_bilinmeyen_key')),
      );

      const error = await service.createUser(createRequest).catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it('constraint adi yoksa (fields sekli) INTERNAL_SERVER_ERROR atar', async () => {
      prisma.user.create.mockRejectedValue(
        prismaError('P2002', {
          driverAdapterError: {
            cause: {
              kind: 'UniqueConstraintViolation',
              constraint: { fields: ['email'] },
            },
          },
        }),
      );

      const error = await service.createUser(createRequest).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it('meta hic yoksa cokmez, INTERNAL_SERVER_ERROR atar', async () => {
      prisma.user.create.mockRejectedValue(prismaError('P2002'));

      const error = await service.createUser(createRequest).catch((e) => e);

      expect(error.message).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });
  });

  // ---Amaç: tanınmayan hataların yutulmadan yukarı taşındığını doğrulamak ---
  describe('createUser - diger hatalar', () => {
    it('P2002 disindaki Prisma hatasini oldugu gibi yukari tasir', async () => {
      const original = prismaError('P2021');
      prisma.user.create.mockRejectedValue(original);

      await expect(service.createUser(createRequest)).rejects.toBe(original);
    });

    it('Prisma disindaki hatayi oldugu gibi yukari tasir', async () => {
      const original = new Error('baglanti koptu');
      prisma.user.create.mockRejectedValue(original);

      await expect(service.createUser(createRequest)).rejects.toBe(original);
    });
  });

  // ---Amaç: register telafisi için kullanıcı silmenin güvenli ve tekrarlanabilir olduğunu doğrulamak ---
  describe('deleteUser', () => {
    it('kaydi siler ve deleted true doner', async () => {
      prisma.user.delete.mockResolvedValue(dbUser());

      await expect(service.deleteUser({ userId: USER_ID })).resolves.toEqual({
        deleted: true,
      });
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: USER_ID },
      });
    });

    it('kayit yoksa deleted false doner ve hata atmaz', async () => {
      prisma.user.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.deleteUser({ userId: USER_ID })).resolves.toEqual({
        deleted: false,
      });
    });

    it('ayni userId icin iki kez cagrilabilir', async () => {
      prisma.user.delete
        .mockResolvedValueOnce(dbUser())
        .mockRejectedValueOnce(prismaError('P2025'));

      await expect(service.deleteUser({ userId: USER_ID })).resolves.toEqual({
        deleted: true,
      });
      await expect(service.deleteUser({ userId: USER_ID })).resolves.toEqual({
        deleted: false,
      });
    });

    it.each([[''], [undefined], [null]])(
      'userId %p ise BAD_REQUEST atar ve veritabanina gitmez',
      async (userId) => {
        const error = await service
          .deleteUser({ userId } as users.UserFindByIdRequest)
          .catch((e) => e);

        expect(error).toBeInstanceOf(RpcException);
        expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
        expect(prisma.user.delete).not.toHaveBeenCalled();
      },
    );

    it('userId uuid formatinda degilse BAD_REQUEST atar', async () => {
      prisma.user.delete.mockRejectedValue(prismaError('P2007'));

      const error = await service
        .deleteUser({ userId: 'uuid-degil' })
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
    });

    it('beklenmeyen Prisma hatasini oldugu gibi yukari tasir', async () => {
      const original = prismaError('P2021');
      prisma.user.delete.mockRejectedValue(original);

      await expect(service.deleteUser({ userId: USER_ID })).rejects.toBe(
        original,
      );
    });
  });

  // ---Amaç: login ve refresh için gereken yetki bilgisinin doğru döndüğünü ve pasif hesabın reddedildiğini doğrulamak ---
  describe('getUserAuthInfo', () => {
    const authRow = (over: Partial<User> = {}) => {
      const { id, role, clinicId, isActive } = dbUser(over);
      return { id, role, clinicId, isActive };
    };

    it('yalnizca yetki icin gereken alanlari secer', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(authRow());

      await service.getUserAuthInfo({ userId: USER_ID });

      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { id: true, role: true, clinicId: true, isActive: true },
      });
    });

    it('PET_OWNER icin clinicId bos string doner', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(authRow());

      await expect(
        service.getUserAuthInfo({ userId: USER_ID }),
      ).resolves.toEqual({
        userId: USER_ID,
        role: users.UserRole.PET_OWNER,
        clinicId: '',
        isActive: true,
      });
    });

    it('klinik hesabi icin rol ve clinicId doner', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        authRow({ role: UserRole.CLINIC, clinicId: CLINIC_ID }),
      );

      await expect(
        service.getUserAuthInfo({ userId: USER_ID }),
      ).resolves.toEqual({
        userId: USER_ID,
        role: users.UserRole.CLINIC,
        clinicId: CLINIC_ID,
        isActive: true,
      });
    });

    it('kullanici yoksa NOT_FOUND atar', async () => {
      prisma.user.findUniqueOrThrow.mockRejectedValue(prismaError('P2025'));

      const error = await service
        .getUserAuthInfo({ userId: USER_ID })
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
    });

    it('pasif hesapta ACCOUNT_DISABLED atar', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        authRow({ isActive: false }),
      );

      const error = await service
        .getUserAuthInfo({ userId: USER_ID })
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.ACCOUNT_DISABLED);
    });

    it('P2025 disindaki hatayi oldugu gibi yukari tasir', async () => {
      const original = prismaError('P2021');
      prisma.user.findUniqueOrThrow.mockRejectedValue(original);

      await expect(service.getUserAuthInfo({ userId: USER_ID })).rejects.toBe(
        original,
      );
    });
  });
});
