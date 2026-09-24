import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [UsersService],
    }).compile();
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      const usersController = app.get<UsersController>(UsersController);
      expect(usersController.getData()).toEqual({message: 'Hello API'});
    });
  });
});
