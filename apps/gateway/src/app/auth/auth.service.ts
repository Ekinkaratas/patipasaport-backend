import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiAuthService {
  getData(): { message: string } {
    return { message: 'Hello pets Auth API' };
  }
}
