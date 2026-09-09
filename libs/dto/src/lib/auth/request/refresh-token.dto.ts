import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenRequestDto implements auth.RefreshTokenRequest {
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
  @MaxLength(512, {
    message: getValidationMessage(
      DtoPrefix.REFRESH_TOKEN,
      ValidationType.MAX_LENGTH,
      512,
    ),
  })
  refreshToken!: string;
}
