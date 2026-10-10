import { Controller } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { auth } from '@libs/proto';
import { Public } from '@libs/common';
import {
  LoginRequestDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RegisterClinicAccountRequestDto,
  RegisterRequestDto,
} from '@libs/dto';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @GrpcMethod(auth.AUTH_SERVICE_NAME, 'Register')
  async register(
    @Payload() request: RegisterRequestDto,
  ): Promise<auth.TokenResponse> {
    return await this.authService.register(request);
  }

  @Public()
  @GrpcMethod(auth.AUTH_SERVICE_NAME, 'RegisterClinicAccount')
  async registerClinicAccount(
    @Payload() request: RegisterClinicAccountRequestDto,
  ): Promise<auth.RegisterClinicAccountResponse> {
    return this.authService.registerClinicAccount(request);
  }

  @Public()
  @GrpcMethod(auth.AUTH_SERVICE_NAME, 'Login')
  async login(
    @Payload() request: LoginRequestDto,
  ): Promise<auth.TokenResponse> {
    return await this.authService.login(request);
  }

  @Public()
  @GrpcMethod(auth.AUTH_SERVICE_NAME, 'RefreshToken')
  async refreshToken(
    @Payload() request: RefreshTokenRequestDto,
  ): Promise<auth.TokenResponse> {
    return this.authService.refreshToken(request);
  }

  @Public()
  @GrpcMethod(auth.AUTH_SERVICE_NAME, 'Logout')
  async logout(
    @Payload() request: LogoutRequestDto,
  ): Promise<auth.LogoutResponse> {
    return this.authService.logout(request);
  }
}
