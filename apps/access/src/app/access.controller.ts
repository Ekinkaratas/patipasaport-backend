import { Controller, Logger } from '@nestjs/common';
import { AccessService } from './access.service';
import { GrpcMethod } from '@nestjs/microservices';
import { access } from '@libs/proto';

@Controller()
export class AccessController {
  private readonly logger = new Logger(AccessController.name);

  constructor(private readonly accessService: AccessService) {}

  @GrpcMethod('AccessService', 'ExchangeToken')
  exchangeToken(
    request: access.ExchangeTokenRequest,
  ): Promise<access.ExchangeTokenResponse> {
    return this.accessService.exchangeToken(request);
  }

  @GrpcMethod('AccessService', 'CreateToken')
  createToken(
    request: access.CreateTokenRequest,
  ): Promise<access.CreateTokenResponse> {
    return this.accessService.createToken(request);
  }
}
