import { Injectable } from '@nestjs/common';

@Injectable()
export class ClinicsService {
  getData(): { message: string } {
    return ({ message: 'Hello API' });
  }
}
