import { Controller, Get } from '@nestjs/common';
import { ApiMedicalRecordService } from './medical-record.service';

@Controller('medical-record')
export class ApiMedicalRecordController {
  constructor(private readonly appService: ApiMedicalRecordService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
