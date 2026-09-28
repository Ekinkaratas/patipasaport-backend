import { Controller } from '@nestjs/common';
import { UsersService } from './users.service';
import { GrpcMethod } from '@nestjs/microservices';
import { users } from '@libs/proto';
import { CreateUserRequestDto } from '@libs/dto';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @GrpcMethod('UsersService', 'CreateUser')
  createUser(dto: CreateUserRequestDto): Promise<users.UserResponse> {
    return this.usersService.createUser(dto);
  }

  @GrpcMethod('UsersService', 'DeleteUser')
  deleteUser(dto: users.DeleteUserRequest): Promise<users.DeleteUserResponse> {
    return this.usersService.deleteUser(dto);
  }
}
