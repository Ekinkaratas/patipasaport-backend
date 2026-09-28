import {
  DtoPrefix,
  getValidationMessage,
  normalizeEmail,
  normalizeTrMobilePhone,
  TR_MOBILE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { users } from '@libs/proto';
import { Transform } from 'class-transformer';
import { FullName } from '../../shared/full-name.decorator';
import {
  IsEmail,
  IsNotEmpty,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateUserRequestDto implements users.CreateUserRequest {
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.USER_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.USER_ID, ValidationType.NOT_EMPTY),
  })
  id!: string;

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
}
