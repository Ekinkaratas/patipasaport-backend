import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiAccessService {
  getData(): { message: string } {
    return { message: 'Hello Access API' };
  }
}
