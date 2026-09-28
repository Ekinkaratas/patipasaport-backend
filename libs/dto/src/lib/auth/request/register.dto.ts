import {
  DtoPrefix,
  getValidationMessage,
  normalizeEmail,
  normalizeTrMobilePhone,
  TR_MOBILE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { auth } from '@libs/proto';
import { Transform } from 'class-transformer';
import { FullName } from '../../shared/full-name.decorator';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/;

export class RegisterRequestDto implements auth.RegisterRequest {
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
  @MaxLength(254, {
    message: getValidationMessage(
      DtoPrefix.EMAIL,
      ValidationType.MAX_LENGTH,
      254,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.EMAIL, ValidationType.NOT_EMPTY),
  })
  email!: string;

  @Matches(PASSWORD_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.WEAK_PASSWORD,
    ),
  })
  @MaxLength(72, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MAX_LENGTH,
      72,
    ),
  })
  @MinLength(8, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MIN_LENGTH,
      8,
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

  @FullName()
  fullName!: string;

  // Girdi: 5551234567 / 05551234567 / +905551234567 / "0555 123 45 67"
  // Çıktı (DB'ye giden): +905551234567
  @Transform(({ value }) => normalizeTrMobilePhone(value))
  @Matches(TR_MOBILE_E164_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.PHONE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  phone!: string;

  @IsIn([auth.ClientType.WEB, auth.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clientType!: auth.ClientType;
}
