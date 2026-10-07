import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { users } from '@libs/proto';
import { IS_PUBLIC_KEY } from '@libs/common';
import { CreateUserRequestDto, userFindByIdRequestDto } from '@libs/dto';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: {
    createUser: jest.Mock;
    deleteUser: jest.Mock;
    getUserAuthInfo: jest.Mock;
  };

  const USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';

  const requests = {
    createUser: {
      id: USER_ID,
      email: 'ali@example.com',
      fullName: 'Ali Veli',
      phone: '+905551234567',
    } as CreateUserRequestDto,
    deleteUser: { userId: USER_ID } as userFindByIdRequestDto,
    getUserAuthInfo: { userId: USER_ID } as userFindByIdRequestDto,
  };

  const responses = {
    createUser: {
      user: {
        userId: USER_ID,
        email: 'ali@example.com',
        fullName: 'Ali Veli',
        phone: '+905551234567',
        role: users.UserRole.PET_OWNER,
        clinicId: '',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    } as users.UserResponse,
    deleteUser: { deleted: true } as users.DeleteUserResponse,
    getUserAuthInfo: {
      userId: USER_ID,
      role: users.UserRole.PET_OWNER,
      clinicId: '',
      isActive: true,
    } as users.GetUserAuthInfoResponse,
  };

  type Method = keyof typeof requests;
  const methods: Method[] = ['createUser', 'deleteUser', 'getUserAuthInfo'];

  beforeEach(async () => {
    usersService = {
      createUser: jest.fn(),
      deleteUser: jest.fn(),
      getUserAuthInfo: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = moduleRef.get(UsersController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya ve erişim kuralına bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydi', () => {
    it.each([
      ['createUser', 'CreateUser'],
      ['deleteUser', 'DeleteUser'],
      ['getUserAuthInfo', 'GetUserAuthInfo'],
    ])('%s, UsersService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        UsersController.prototype[method as Method],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: users.USERS_SERVICE_NAME, rpc }),
      ]);
    });

    it.each([
      ['createUser', CreateUserRequestDto],
      ['deleteUser', userFindByIdRequestDto],
      ['getUserAuthInfo', userFindByIdRequestDto],
    ])(
      '%s parametresi dogrulama icin DTO sinifiyla tiplenmistir',
      (method, dto) => {
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            UsersController.prototype,
            method,
          ),
        ).toEqual([dto]);
      },
    );

    it.each(methods)(
      '%s @Public isaretlidir (auth kullanici JWT si olmadan cagirir)',
      (method) => {
        expect(
          Reflect.getMetadata(IS_PUBLIC_KEY, UsersController.prototype[method]),
        ).toBe(true);
      },
    );
  });

  // ---Amaç: her handler'ın isteği servise olduğu gibi devrettiğini doğrulamak ---
  describe.each(methods)('%s', (method) => {
    it('istegi UsersService-e oldugu gibi devreder', async () => {
      usersService[method].mockResolvedValue(responses[method]);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).resolves.toBe(responses[method]);
      expect(usersService[method]).toHaveBeenCalledWith(requests[method]);
      expect(usersService[method]).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('servis hatasi');
      usersService[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (req: unknown) => Promise<unknown>)(
          requests[method],
        ),
      ).rejects.toBe(error);
    });
  });

  // ---Amaç: telafi silmesinde kayıt bulunamadı yanıtının hata sayılmadığını doğrulamak ---
  describe('deleteUser kayit yok', () => {
    it('deleted false yanitini oldugu gibi gecirir', async () => {
      usersService.deleteUser.mockResolvedValue({ deleted: false });

      await expect(controller.deleteUser(requests.deleteUser)).resolves.toEqual(
        { deleted: false },
      );
    });
  });
});
