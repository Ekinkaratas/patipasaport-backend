import { Controller, Get } from '@nestjs/common';
import { MedicalRecordService } from './medical-record.service';

@Controller()
export class MedicalRecordController {
  constructor(private readonly medicalRecordService: MedicalRecordService) {}

  @Get()
  getData() {
    return this.medicalRecordService.getData();
  }
}
