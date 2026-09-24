import { Test, TestingModule } from '@nestjs/testing';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';

describe('PetsController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [PetsController],
      providers: [PetsService],
    }).compile();
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      const petsController = app.get<PetsController>(PetsController);
      expect(petsController.getData()).toEqual({message: 'Hello API'});
    });
  });
});
