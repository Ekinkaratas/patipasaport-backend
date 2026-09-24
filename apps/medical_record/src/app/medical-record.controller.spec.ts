import { Test, TestingModule } from '@nestjs/testing';
import { MedicalRecordController } from './medical-record.controller';
import { MedicalRecordService } from './medical-record.service';

describe('MedicalRecordController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [MedicalRecordController],
      providers: [MedicalRecordService],
    }).compile();
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      const medicalRecordController = app.get<MedicalRecordController>(MedicalRecordController);
      expect(medicalRecordController.getData()).toEqual({message: 'Hello API'});
    });
  });
});
