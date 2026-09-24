import { Test } from '@nestjs/testing';
import { ClinicsService } from './clinics.service';

describe('ClinicsService', () => {
  let service: ClinicsService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [ClinicsService],
    }).compile();

    service = app.get<ClinicsService>(ClinicsService);
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      expect(service.getData()).toEqual({message: 'Hello API'});
    });
  });
});
