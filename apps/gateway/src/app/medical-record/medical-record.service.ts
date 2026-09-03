import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiMedicalRecordService {
  getData(): { message: string } {
    return { message: 'Hello medical-record API' };
  }
}
