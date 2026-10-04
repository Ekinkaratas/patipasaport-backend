import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenRequestDto implements auth.RefreshTokenRequest {
  @MaxLength(512, {
    message: getValidationMessage(
      DtoPrefix.REFRESH_TOKEN,
      ValidationType.MAX_LENGTH,
      512,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.REFRESH_TOKEN,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.REFRESH_TOKEN,
      ValidationType.NOT_EMPTY,
    ),
  })
  refreshToken!: string;

  @IsIn([auth.ClientType.WEB, auth.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clientType!: auth.ClientType;
}
