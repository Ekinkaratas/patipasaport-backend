import { users } from '@libs/proto';

export class GetMeResponseDto implements users.GetMeResponse {
  userId!: string;
  email!: string;
  fullName!: string;
  phone!: string;
  role!: users.UserRole;
  clinicId!: string; /** eğer user bir klinik personeli değilse burası boş string döner */
  isActive!: boolean;
  addressLine!: string;
  city!: string;
  district!: string;
  createdAt!: string;
  updatedAt!: string;
}
