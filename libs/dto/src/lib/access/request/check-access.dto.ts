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
  IsIn,
  IsUUID,
} from 'class-validator';

export class CheckAccessRequestDto implements access.CheckAccessRequest {
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

  @IsIn(CONSENT_SCOPES, {
    each: true,
    message: getValidationMessage(DtoPrefix.SCOPES, ValidationType.NOT_VALID),
  })
  @ArrayUnique({
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MUST_BE_UNIQUE,
    ),
  })
  @ArrayMaxSize(CONSENT_SCOPES.length, {
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MAX,
      CONSENT_SCOPES.length,
    ),
  })
  @ArrayMinSize(1, {
    message: getValidationMessage(DtoPrefix.SCOPES, ValidationType.MIN, 1),
  })
  @IsArray({
    message: getValidationMessage(
      DtoPrefix.SCOPES,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  requiredScopes!: string[];
}
