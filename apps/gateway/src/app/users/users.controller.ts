import { Controller, Get } from '@nestjs/common';
import { ApiUserService } from './users.service';

@Controller('users')
export class ApiUserController {
  constructor(private readonly appService: ApiUserService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }
}
