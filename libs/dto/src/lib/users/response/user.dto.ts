import { users } from '@libs/proto';

export class UserResponseDto implements users.UserResponse {
  user: users.User | undefined;
}
