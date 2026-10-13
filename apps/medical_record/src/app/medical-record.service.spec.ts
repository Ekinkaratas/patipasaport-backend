import { Test } from '@nestjs/testing';
import { MedicalRecordService } from './medical-record.service';

describe('MedicalRecordService', () => {
  let service: MedicalRecordService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [MedicalRecordService],
    }).compile();

    service = app.get<MedicalRecordService>(MedicalRecordService);
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      expect(service.getData()).toEqual({ message: 'Hello API' });
    });
  });
});
