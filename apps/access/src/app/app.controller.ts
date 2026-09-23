import { Controller } from '@nestjs/common';
import { AppService } from './app.service';
import { GrpcMethod } from '@nestjs/microservices';
import { access } from '@libs/proto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @GrpcMethod('AccessService', 'ExchangeToken')
  exchangeToken(request: access.ExchangeTokenRequest) {
    return this.appService.exchangeToken(request);
  }
}
