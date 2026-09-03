import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiPetsService {
  getData(): { message: string } {
    return { message: 'Hello pets gateway API' };
  }
}
