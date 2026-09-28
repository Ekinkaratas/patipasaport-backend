import { Controller, Logger } from '@nestjs/common';
import { AccessService } from './access.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { access } from '@libs/proto';
import { ExchangeTokenRequestDto } from '@libs/dto';

@Controller()
export class AccessController {
  private readonly logger = new Logger(AccessController.name);

  constructor(private readonly accessService: AccessService) {}

  @GrpcMethod('AccessService', 'ExchangeToken')
  exchangeToken(
    @Payload() request: ExchangeTokenRequestDto,
  ): Promise<access.ExchangeTokenResponse> {
    return this.accessService.exchangeToken(request);
  }

  @GrpcMethod('AccessService', 'CreateOpaqueToken')
  createOpaqueToken(
    request: access.CreateTokenRequest,
  ): Promise<access.CreateTokenResponse> {
    return this.accessService.createOpaqueToken(request);
  }

  @GrpcMethod('AccessService', 'RevokeToken')
  revokeToken(
    request: access.RevokeTokenRequest,
  ): Promise<access.RevokeTokenResponse> {
    return this.accessService.revokeToken(request);
  }
}
