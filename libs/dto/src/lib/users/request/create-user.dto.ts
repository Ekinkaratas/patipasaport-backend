import {
  DtoPrefix,
  getValidationMessage,
  normalizeTrMobilePhone,
  TR_MOBILE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { users } from '@libs/proto';
import { Transform } from 'class-transformer';
import { FullName } from '../../shared/full-name.decorator';
import { AccountEmail } from '../../shared/account-fields.decorator';
import { IsNotEmpty, IsUUID, Matches } from 'class-validator';

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

  @AccountEmail()
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
