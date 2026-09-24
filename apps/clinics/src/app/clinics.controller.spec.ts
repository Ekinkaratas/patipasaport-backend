import { Test, TestingModule } from '@nestjs/testing';
import { ClinicsController } from './clinics.controller';
import { ClinicsService } from './clinics.service';

describe('ClinicsController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [ClinicsController],
      providers: [ClinicsService],
    }).compile();
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      const clinicsController = app.get<ClinicsController>(ClinicsController);
      expect(clinicsController.getData()).toEqual({message: 'Hello API'});
    });
  });
});
