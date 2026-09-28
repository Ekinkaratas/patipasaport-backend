import { Test, TestingModule } from '@nestjs/testing';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { users } from '@libs/proto';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: { createUser: jest.Mock; deleteUser: jest.Mock };

  const createRequest: users.CreateUserRequest = {
    id: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
    email: 'ali@example.com',
    fullName: 'Ali Veli',
    phone: '+905551234567',
  };

  beforeEach(async () => {
    usersService = { createUser: jest.fn(), deleteUser: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = moduleRef.get(UsersController);
  });

  describe('gRPC handler kaydi', () => {
    it.each([
      ['createUser', 'CreateUser'],
      ['deleteUser', 'DeleteUser'],
    ])('%s, UsersService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        UsersController.prototype[method as keyof UsersController],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: 'UsersService', rpc }),
      ]);
    });
  });

  describe('createUser', () => {
    it('istegi UsersService-e oldugu gibi devreder', async () => {
      const expected: users.UserResponse = {
        user: {
          userId: createRequest.id,
          email: createRequest.email,
          fullName: createRequest.fullName,
          phone: createRequest.phone,
          role: users.UserRole.PET_OWNER,
          clinicId: '',
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };
      usersService.createUser.mockResolvedValue(expected);

      await expect(controller.createUser(createRequest)).resolves.toBe(
        expected,
      );
      expect(usersService.createUser).toHaveBeenCalledWith(createRequest);
      expect(usersService.createUser).toHaveBeenCalledTimes(1);
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('EMAIL_ALREADY_EXISTS');
      usersService.createUser.mockRejectedValue(error);

      await expect(controller.createUser(createRequest)).rejects.toBe(error);
    });
  });

  describe('deleteUser', () => {
    it('istegi UsersService-e oldugu gibi devreder', async () => {
      const expected: users.DeleteUserResponse = { deleted: true };
      usersService.deleteUser.mockResolvedValue(expected);

      const request: users.DeleteUserRequest = { userId: createRequest.id };

      await expect(controller.deleteUser(request)).resolves.toBe(expected);
      expect(usersService.deleteUser).toHaveBeenCalledWith(request);
    });

    it('kayit bulunamadi yanitini oldugu gibi gecirir', async () => {
      usersService.deleteUser.mockResolvedValue({ deleted: false });

      await expect(
        controller.deleteUser({ userId: createRequest.id }),
      ).resolves.toEqual({ deleted: false });
    });

    it('servisten gelen hatayi yutmaz', async () => {
      const error = new Error('BAD_REQUEST');
      usersService.deleteUser.mockRejectedValue(error);

      await expect(controller.deleteUser({ userId: '' })).rejects.toBe(error);
    });
  });
});
