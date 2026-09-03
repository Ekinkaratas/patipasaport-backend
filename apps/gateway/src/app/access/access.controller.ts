import { Controller, Get } from '@nestjs/common';
import { ApiAccessService } from './access.service';

@Controller('access')
export class ApiAccessController {
  constructor(private readonly appService: ApiAccessService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
