import { users } from '@libs/proto';

export class GetUserAuthInfoResponseDto
  implements users.GetUserAuthInfoResponse
{
  userId!: string;
  role!: users.UserRole;
  clinicId!: string;
  isActive!: boolean;
}
