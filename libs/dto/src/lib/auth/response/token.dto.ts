import { auth } from '@libs/proto';

export class TokenResponseDto implements auth.TokenResponse {
  accessToken!: string;
  refreshToken!: string;
  tokenType!: string;
  expiresIn!: number;
  userId!: string;
  clinicId!: string;
}
