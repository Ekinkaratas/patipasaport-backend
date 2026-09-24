import { Injectable } from '@nestjs/common';

@Injectable()
export class MedicalRecordService {
  getData(): { message: string } {
    return ({ message: 'Hello API' });
  }
}
