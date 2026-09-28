import {
  DtoPrefix,
  getValidationMessage,
  normalizeEmail,
  ValidationType,
} from '@libs/common';
import { auth } from '@libs/proto';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class LoginRequestDto implements auth.LoginRequest {
  // Register ile aynı normalizasyon — kayıtlı email küçük harfle tutulur.
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail(
    {},
    {
      message: getValidationMessage(
        DtoPrefix.EMAIL,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    },
  )
  @MaxLength(255, {
    message: getValidationMessage(
      DtoPrefix.EMAIL,
      ValidationType.MAX_LENGTH,
      255,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.EMAIL, ValidationType.NOT_EMPTY),
  })
  email!: string;

  @MaxLength(72, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MAX_LENGTH,
      72,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PASSWORD, ValidationType.NOT_EMPTY),
  })
  password!: string;

  @IsIn([auth.ClientType.WEB, auth.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clientType!: auth.ClientType;

  // "Oturumu hatırla". Gönderilmezse false sayılır (refresh token 12 saat).
  @IsOptional()
  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.REMEMBER_ME,
      ValidationType.WRONG_DATA_TYPE,
    ),
  })
  rememberMe!: boolean;
}
