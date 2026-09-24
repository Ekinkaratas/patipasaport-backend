import { Injectable } from '@nestjs/common';

@Injectable()
export class PetsService {
  getData(): { message: string } {
    return ({ message: 'Hello API' });
  }
}
