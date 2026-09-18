import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { access } from '@libs/proto';
import { IsUUID } from 'class-validator';

export class RevokeConsentRequestDto implements access.RevokeConsentRequest {
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CONSENT_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  consentId!: string;
}
