import { Test } from '@nestjs/testing';
import { PetsService } from './pets.service';

describe('PetsService', () => {
  let service: PetsService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [PetsService],
    }).compile();

    service = app.get<PetsService>(PetsService);
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      expect(service.getData()).toEqual({message: 'Hello API'});
    });
  });
});
