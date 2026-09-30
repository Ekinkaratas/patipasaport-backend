import { access } from '@libs/proto';

export class CreateTokenResponseDto implements access.CreateTokenResponse {
  opaqueToken!: string;
  expiresIn!: number;
  issuedAt!: string;
  expiresAt!: string;
}
