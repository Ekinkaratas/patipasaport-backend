import { users } from '@libs/proto';

export class ListUsersByClinicResponseDto
  implements users.ListUsersByClinicResponse
{
  users!: users.User[];
  total!: number;
  page!: number;
  pageSize!: number;
}
