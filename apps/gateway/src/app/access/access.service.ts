import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { access } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  ResponseMessages,
} from '@libs/common';

@Injectable()
export class ApiAccessService implements OnModuleInit {
  private accessClient!: access.AccessServiceClient;

  constructor(@Inject('ACCESS_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.accessClient = this.client.getService<access.AccessServiceClient>(
      access.ACCESS_SERVICE_NAME,
    );
  }

  async grantConsent(
    request: access.GrantConsentRequest,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    const data = await firstValueFrom(this.accessClient.grantConsent(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async revokeConsent(
    request: access.RevokeConsentRequest,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    const data = await firstValueFrom(
      this.accessClient.revokeConsent(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async getConsentStatus(
    request: access.GetConsentStatusRequest,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    const data = await firstValueFrom(
      this.accessClient.getConsentStatus(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async listMyConsents(
    request: access.ListMyConsentsRequest,
  ): Promise<BaseResponse<access.ListMyConsentsResponse>> {
    const data = await firstValueFrom(
      this.accessClient.listMyConsents(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }
}
