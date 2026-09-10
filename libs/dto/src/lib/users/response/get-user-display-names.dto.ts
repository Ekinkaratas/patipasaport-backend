import { users } from '@libs/proto';

export class GetUserDisplayNamesResponseDto
  implements users.GetUserDisplayNamesResponse
{
  users!: users.UserDisplayName[];
  notFoundIds!: string[];
}
