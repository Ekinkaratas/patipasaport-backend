import { Controller } from '@nestjs/common';
import { UsersService } from './users.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { users } from '@libs/proto';
import { AuthUser, CurrentUser, Public, Roles } from '@libs/common';
import {
  CreateUserRequestDto,
  userFindByIdRequestDto,
  UpdateUserRequestDto,
  GetUserDisplayNamesRequesDto,
  GetUserContactRequestDto,
  CreateClinicUserRequestDto,
  DeactivateClinicUsersRequestDto,
} from '@libs/dto';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Public()
  @GrpcMethod(users.USERS_SERVICE_NAME, 'CreateUser')
  async createUser(
    @Payload() dto: CreateUserRequestDto,
  ): Promise<users.UserResponse> {
    return this.usersService.createUser(dto);
  }

  @Public()
  @GrpcMethod(users.USERS_SERVICE_NAME, 'DeleteUser')
  async deleteUser(
    @Payload() dto: userFindByIdRequestDto,
  ): Promise<users.DeleteUserResponse> {
    return this.usersService.deleteUser(dto);
  }

  @Public()
  @GrpcMethod(users.USERS_SERVICE_NAME, 'GetUserAuthInfo')
  async getUserAuthInfo(
    @Payload() dto: userFindByIdRequestDto,
  ): Promise<users.GetUserAuthInfoResponse> {
    return this.usersService.getUserAuthInfo(dto);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'GetMe')
  async getMe(@CurrentUser() user: AuthUser): Promise<users.GetMeResponse> {
    return this.usersService.getMe(user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'UpdateMe')
  async updateMe(
    @Payload() request: UpdateUserRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<users.UserResponse> {
    return this.usersService.updateMe(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'GetUserRole')
  async getUserRole(
    @Payload() request: userFindByIdRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<users.GetUserRoleResponse> {
    return this.usersService.getUserRole(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'GetUserDisplayNames')
  async getUserDisplayNames(
    @Payload() request: GetUserDisplayNamesRequesDto,
  ): Promise<users.GetUserDisplayNamesResponse> {
    return this.usersService.getUserDisplayNames(request);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'GetUserContact')
  async getUserContact(
    @Payload() request: GetUserContactRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<users.GetUserContactResponse> {
    return this.usersService.getUserContact(request, user);
  }

  @Public()
  @GrpcMethod(users.USERS_SERVICE_NAME, 'CreateClinicUser')
  async createClinicUser(
    @Payload() dto: CreateClinicUserRequestDto,
  ): Promise<users.UserResponse> {
    return this.usersService.createClinicUser(dto);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'DeactivateMe')
  async deactivateMe(
    @CurrentUser() user: AuthUser,
  ): Promise<users.UserResponse> {
    return this.usersService.deactivateMe(user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(users.USERS_SERVICE_NAME, 'DeactivateClinicUsers')
  async deactivateClinicUsers(
    @Payload() request: DeactivateClinicUsersRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<users.DeactivateClinicUsersResponse> {
    return this.usersService.deactivateClinicUsers(request, user);
  }
}
