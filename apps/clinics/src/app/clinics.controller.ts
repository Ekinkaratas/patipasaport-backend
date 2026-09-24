import { Controller, Get } from '@nestjs/common';
import { ClinicsService } from './clinics.service';

@Controller()
export class ClinicsController {
  constructor(private readonly clinicsService: ClinicsService) {}

  @Get()
  getData() {
    return this.clinicsService.getData();
  }
}
