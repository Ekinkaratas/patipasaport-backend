import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { auth } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  ResponseMessages,
} from '@libs/common';

const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;

@Injectable()
export class ApiAuthService implements OnModuleInit {
  private authClient!: auth.AuthServiceClient;

  constructor(@Inject('AUTH_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.authClient = this.client.getService<auth.AuthServiceClient>(
      auth.AUTH_SERVICE_NAME,
    );
  }

  async register(
    request: auth.RegisterRequest,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    const data = await firstValueFrom(this.authClient.register(request));
    return new BaseResponse(
      data,
      ResponseMessages.CREATED,
      true,
      getCorrelationId(),
    );
  }

  async login(
    request: auth.LoginRequest,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    const data = await firstValueFrom(this.authClient.login(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async refreshToken(
    request: auth.RefreshTokenRequest,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    const data = await firstValueFrom(this.authClient.refreshToken(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async logout(
    refreshToken: string,
    authorization?: string,
  ): Promise<BaseResponse<auth.LogoutResponse>> {
    const opaqueToken = BEARER_PATTERN.exec(authorization ?? '')?.[1];
    const data = await firstValueFrom(
      this.authClient.logout({ refreshToken, opaqueToken }),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }
}
