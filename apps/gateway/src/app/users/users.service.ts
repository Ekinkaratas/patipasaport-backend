import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { users } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  ResponseMessages,
} from '@libs/common';

@Injectable()
export class ApiUserService implements OnModuleInit {
  private usersClient!: users.UsersServiceClient;

  constructor(@Inject('USERS_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.usersClient = this.client.getService<users.UsersServiceClient>(
      users.USERS_SERVICE_NAME,
    );
  }

  async getMe(): Promise<BaseResponse<users.GetMeResponse>> {
    const data = await firstValueFrom(this.usersClient.getMe({}));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async updateMe(
    request: users.UpdateMeRequest,
  ): Promise<BaseResponse<users.UserResponse>> {
    const data = await firstValueFrom(this.usersClient.updateMe(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async deactivateMe(): Promise<BaseResponse<users.UserResponse>> {
    const data = await firstValueFrom(this.usersClient.deactivateMe({}));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async getUserDisplayNames(
    request: users.GetUserDisplayNamesRequest,
  ): Promise<BaseResponse<users.GetUserDisplayNamesResponse>> {
    const data = await firstValueFrom(
      this.usersClient.getUserDisplayNames(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }
}
