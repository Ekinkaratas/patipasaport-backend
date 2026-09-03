import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiClinicsService {
  getData(): { message: string } {
    return { message: 'Hello clinics API' };
  }
}
