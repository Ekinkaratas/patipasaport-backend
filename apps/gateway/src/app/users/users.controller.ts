import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { BaseResponse } from '@libs/common';
import {
  GetUserDisplayNamesRequesDto,
  UpdateUserRequestDto,
} from '@libs/dto';
import { users } from '@libs/proto';
import { ApiUserService } from './users.service';

@Controller('users')
export class ApiUserController {
  constructor(private readonly usersService: ApiUserService) {}

  @Get('me')
  getMe(): Promise<BaseResponse<users.GetMeResponse>> {
    return this.usersService.getMe();
  }

  @Patch('me')
  updateMe(
    @Body() request: UpdateUserRequestDto,
  ): Promise<BaseResponse<users.UserResponse>> {
    return this.usersService.updateMe(request);
  }

  @Post('me/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateMe(): Promise<BaseResponse<users.UserResponse>> {
    return this.usersService.deactivateMe();
  }

  @Post('display-names')
  @HttpCode(HttpStatus.OK)
  getUserDisplayNames(
    @Body() request: GetUserDisplayNamesRequesDto,
  ): Promise<BaseResponse<users.GetUserDisplayNamesResponse>> {
    return this.usersService.getUserDisplayNames(request);
  }
}
