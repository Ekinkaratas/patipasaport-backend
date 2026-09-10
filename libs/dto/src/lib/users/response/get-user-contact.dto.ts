import { users } from '@libs/proto';

export class GetUserContactResponseDto implements users.GetUserContactResponse {
  userId!: string;
  fullName!: string;
  phone!: string;
  email!: string;
  addressLine!: string;
  city!: string;
  district!: string;
}
