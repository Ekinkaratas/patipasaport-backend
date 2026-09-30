import { Controller } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { auth } from '@libs/proto';
import { LoginRequestDto, RegisterRequestDto } from '@libs/dto';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @GrpcMethod('AuthService', 'Register')
  async register(
    @Payload() request: RegisterRequestDto,
  ): Promise<auth.TokenResponse> {
    return await this.authService.register(request);
  }

  @GrpcMethod('AuthService', 'Login')
  async login(
    @Payload() request: LoginRequestDto,
  ): Promise<auth.TokenResponse> {
    return await this.authService.login(request);
  }
}
