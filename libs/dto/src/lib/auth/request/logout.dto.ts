import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class LogoutRequestDto implements auth.LogoutRequest {
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

  @IsOptional({
    message: getValidationMessage(
      DtoPrefix.OPAQUE_TOKEN,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.OPAQUE_TOKEN,
      ValidationType.NOT_EMPTY,
    ),
  })
  opaqueToken?: string;
}
