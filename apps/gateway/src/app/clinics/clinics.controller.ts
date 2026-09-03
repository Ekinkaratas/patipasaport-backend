import { Controller, Get } from '@nestjs/common';
import { ApiClinicsService } from './clinics.service';

@Controller('clinics')
export class ApiClinicsController {
  constructor(private readonly appService: ApiClinicsService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
