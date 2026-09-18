import { access } from '@libs/proto';

export class ConsentResponseDto implements access.ConsentResponse {
  consentId!: string;
  status!: access.ConsentStatus;
  ownerUserId!: string;
  clinicId!: string;
  petId!: string;
  scopes!: string[];
  grantedAt!: string;
  expiresAt!: string;
  revokedAt!: string;
}
