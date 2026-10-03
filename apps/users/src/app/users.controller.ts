import { Controller } from '@nestjs/common';
import { UsersService } from './users.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { users } from '@libs/proto';
import { Public } from '@libs/common';
import { CreateUserRequestDto, userFindByIdRequestDto } from '@libs/dto';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Public()
  @GrpcMethod('UsersService', 'CreateUser')
  createUser(
    @Payload() dto: CreateUserRequestDto,
  ): Promise<users.UserResponse> {
    return this.usersService.createUser(dto);
  }

  @Public()
  @GrpcMethod('UsersService', 'DeleteUser')
  deleteUser(
    @Payload() dto: userFindByIdRequestDto,
  ): Promise<users.DeleteUserResponse> {
    return this.usersService.deleteUser(dto);
  }

  @Public()
  @GrpcMethod('UsersService', 'GetUserAuthInfo')
  getUserAuthInfo(
    @Payload() dto: userFindByIdRequestDto,
  ): Promise<users.GetUserAuthInfoResponse> {
    return this.usersService.getUserAuthInfo(dto);
  }
}
