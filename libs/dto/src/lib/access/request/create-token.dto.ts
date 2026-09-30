import {
  DtoPrefix,
  getValidationMessage,
  TOKEN_ROLES,
  ValidationType,
} from '@libs/common';
import { access } from '@libs/proto';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateTokenRequestDto implements access.CreateTokenRequest {
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.USER_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.USER_ID, ValidationType.NOT_EMPTY),
  })
  userId!: string;

  @IsIn(TOKEN_ROLES, {
    message: getValidationMessage(
      DtoPrefix.USER_ROLE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  role!: string;

  @ValidateIf((o) => o.clinicId !== '')
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clinicId!: string;

  @IsIn([access.ClientType.WEB, access.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.NOT_VALID,
    ),
  })
  clientType!: access.ClientType;

  @Min(0, {
    message: getValidationMessage(DtoPrefix.TTL_SECONDS, ValidationType.MIN, 0),
  })
  @IsInt({
    message: getValidationMessage(
      DtoPrefix.TTL_SECONDS,
      ValidationType.MUST_BE_NUMBER,
    ),
  })
  ttlSeconds!: number;
}
