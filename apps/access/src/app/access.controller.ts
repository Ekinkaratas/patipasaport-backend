import { Controller } from '@nestjs/common';
import { AccessService } from './access.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { access } from '@libs/proto';
import { Public } from '@libs/common';
import {
  CreateTokenRequestDto,
  ExchangeTokenRequestDto,
  RevokeTokenRequestDto,
} from '@libs/dto';

@Controller()
export class AccessController {
  constructor(private readonly accessService: AccessService) {}

  @Public()
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'ExchangeToken')
  exchangeToken(
    @Payload() request: ExchangeTokenRequestDto,
  ): Promise<access.ExchangeTokenResponse> {
    return this.accessService.exchangeToken(request);
  }

  @Public()
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'CreateOpaqueToken')
  createOpaqueToken(
    @Payload() request: CreateTokenRequestDto,
  ): Promise<access.CreateTokenResponse> {
    return this.accessService.createOpaqueToken(request);
  }

  @Public()
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'RevokeToken')
  revokeToken(
    @Payload() request: RevokeTokenRequestDto,
  ): Promise<access.RevokeTokenResponse> {
    return this.accessService.revokeToken(request);
  }
}
