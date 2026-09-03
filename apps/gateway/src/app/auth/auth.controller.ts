import { Controller, Get } from '@nestjs/common';
import { ApiAuthService } from './auth.service';

@Controller('auth')
export class ApiAuthController {
  constructor(private readonly appService: ApiAuthService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
