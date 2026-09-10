import { users } from '@libs/proto';

export class GetUserRoleResponseDto implements users.GetUserRoleResponse {
  userId!: string;
  role!: users.UserRole;
  clinicId!: string;
}
