import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  BaseResponse,
  ClientTypeHeaderInterceptor,
  Public,
} from '@libs/common';
import {
  LoginRequestDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RegisterRequestDto,
} from '@libs/dto';
import { auth } from '@libs/proto';
import { RateLimit } from '../security/rate-limit';
import { ApiAuthService } from './auth.service';
import { RefreshCookie } from './refresh-cookie';

const IssueRefreshCookie = RefreshCookie({ read: false, write: 'set' });
const RotateRefreshCookie = RefreshCookie({ read: true, write: 'set' });
const ClearRefreshCookie = RefreshCookie({ read: true, write: 'clear' });

@Controller('auth')
export class ApiAuthController {
  constructor(private readonly authService: ApiAuthService) {}

  @Public()
  @RateLimit('auth')
  @Post('register')
  @UseInterceptors(ClientTypeHeaderInterceptor, IssueRefreshCookie)
  register(
    @Body() request: RegisterRequestDto,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    return this.authService.register(request);
  }

  @Public()
  @RateLimit('auth')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ClientTypeHeaderInterceptor, IssueRefreshCookie)
  login(
    @Body() request: LoginRequestDto,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    return this.authService.login(request);
  }

  @Public()
  @RateLimit('auth')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ClientTypeHeaderInterceptor, RotateRefreshCookie)
  refreshToken(
    @Body() request: RefreshTokenRequestDto,
  ): Promise<BaseResponse<auth.TokenResponse>> {
    return this.authService.refreshToken(request);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ClearRefreshCookie)
  logout(
    @Body() request: LogoutRequestDto,
    @Headers('authorization') authorization?: string,
  ): Promise<BaseResponse<auth.LogoutResponse>> {
    return this.authService.logout(request.refreshToken, authorization);
  }
}
