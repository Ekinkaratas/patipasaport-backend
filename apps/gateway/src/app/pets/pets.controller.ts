import { Controller, Get } from '@nestjs/common';
import { ApiPetsService } from './pets.service';

@Controller('pets')
export class ApiPetsController {
  constructor(private readonly appService: ApiPetsService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
