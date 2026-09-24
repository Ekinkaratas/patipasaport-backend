import { Controller, Get } from '@nestjs/common';
import { PetsService } from './pets.service';

@Controller()
export class PetsController {
  constructor(private readonly petsService: PetsService) {}

  @Get()
  getData() {
    return this.petsService.getData();
  }
}
