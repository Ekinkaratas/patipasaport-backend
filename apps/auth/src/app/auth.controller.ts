import { Controller, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { auth } from '@libs/proto';
import { RegisterRequestDto } from '@libs/dto';

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @GrpcMethod('AuthService', 'Register')
  async register(
    @Payload() request: RegisterRequestDto,
  ): Promise<auth.TokenResponse> {
    return await this.authService.register(request);
  }

  @GrpcMethod('AuthService', 'DeleteInCredential')
  async deleteInCredential(
    req: auth.DeleteInCredentialRequest,
  ): Promise<auth.DeleteInCredentialResponse> {
    return await this.authService.deleteInCredential(req);
  }
}
