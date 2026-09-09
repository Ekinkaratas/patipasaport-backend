import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class LoginRequestDto implements auth.LoginRequest {
  @IsEmail(
    {},
    {
      message: getValidationMessage(
        DtoPrefix.EMAIL,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    },
  )
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.EMAIL, ValidationType.NOT_EMPTY),
  })
  @MaxLength(255, {
    message: getValidationMessage(
      DtoPrefix.EMAIL,
      ValidationType.MAX_LENGTH,
      255,
    ),
  })
  email!: string;

  @IsString({
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PASSWORD, ValidationType.NOT_EMPTY),
  })
  @MaxLength(72, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MAX_LENGTH,
      72,
    ),
  })
  password!: string;

  @IsIn([auth.ClientType.WEB, auth.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clientType!: auth.ClientType;
}
