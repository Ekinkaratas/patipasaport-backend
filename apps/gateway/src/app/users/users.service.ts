import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiUserService {
  getData(): { message: string } {
    return { message: 'Hello User gateway API' };
  }
}
