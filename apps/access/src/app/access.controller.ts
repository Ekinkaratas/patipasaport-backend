import { Controller } from '@nestjs/common';
import { AccessService } from './access.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { access } from '@libs/proto';
import { AuthUser, CurrentUser, Public, Roles } from '@libs/common';
import {
  CheckAccessRequestDto,
  CreateTokenRequestDto,
  ExchangeTokenRequestDto,
  GetConsentStatusRequestDto,
  GrantConsentRequestDto,
  ListMyConsentsRequestDto,
  RevokeConsentRequestDto,
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

  @Roles(['CLINIC'])
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'CheckAccess')
  async checkAccess(
    @Payload() request: CheckAccessRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<access.CheckAccessResponse> {
    return this.accessService.checkAccess(request, user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'GrantConsent')
  async grantConsent(
    @Payload() request: GrantConsentRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<access.ConsentResponse> {
    return this.accessService.grantConsent(request, user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'RevokeConsent')
  async revokeConsent(
    @Payload() request: RevokeConsentRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<access.ConsentResponse> {
    return this.accessService.revokeConsent(request, user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'GetConsentStatus')
  async getConsentStatus(
    @Payload() request: GetConsentStatusRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<access.ConsentResponse> {
    return this.accessService.getConsentStatus(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(access.ACCESS_SERVICE_NAME, 'ListMyConsents')
  async listMyConsents(
    @Payload() request: ListMyConsentsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<access.ListMyConsentsResponse> {
    return this.accessService.listMyConsents(request, user);
  }
}
