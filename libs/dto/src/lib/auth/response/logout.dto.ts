import { auth } from '@libs/proto';

export class LogoutResponseDto implements auth.LogoutResponse {
  success!: boolean;
}
