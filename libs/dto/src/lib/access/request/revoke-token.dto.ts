import {
  DtoPrefix,
  getValidationMessage,
  ValidationType,
} from '@libs/common';
import { access } from '@libs/proto';
import { IsNotEmpty, IsString } from 'class-validator';

export class RevokeTokenRequestDto implements access.RevokeTokenRequest {
  @IsString({
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
  opaqueToken!: string;
}
