import {
  CONSENT_SCOPES,
  DtoPrefix,
  getValidationMessage,
  ValidationType,
} from '@libs/common';
import { access } from '@libs/proto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsUUID,
} from 'class-validator';

export class GrantConsentRequestDto implements access.GrantConsentRequest {
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clinicId!: string;

  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  petId!: string;

  @IsArray({
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  @ArrayMinSize(1, {
    message: getValidationMessage(DtoPrefix.SCOPES, ValidationType.MIN, 1),
  })
  @ArrayMaxSize(CONSENT_SCOPES.length, {
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MAX,
      CONSENT_SCOPES.length,
    ),
  })
  @ArrayUnique({
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MUST_BE_UNIQUE,
    ),
  })
  @IsIn(CONSENT_SCOPES, {
    each: true,
    message: getValidationMessage(DtoPrefix.SCOPES, ValidationType.NOT_VALID),
  })
  scopes!: string[];

  @IsDateString(
    { strict: true },
    {
      message: getValidationMessage(
        DtoPrefix.EXPIRES_AT,
        ValidationType.MUST_BE_DATE,
      ),
    },
  )
  expiresAt!: string;
}
