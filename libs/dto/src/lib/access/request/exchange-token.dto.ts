import {
  DtoPrefix,
  getValidationMessage,
  ValidationType,
} from '@libs/common';
import { access } from '@libs/proto';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ExchangeTokenRequestDto implements access.ExchangeTokenRequest {
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

  // CLIENT_TYPE_UNSPECIFIED (0) kabul edilmez — token yalnızca üretildiği
  // istemci türünde geçerli olsun diye WEB/MOBILE açıkça istenir.
  @IsIn([access.ClientType.WEB, access.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.NOT_VALID,
    ),
  })
  clientType!: access.ClientType;
}
