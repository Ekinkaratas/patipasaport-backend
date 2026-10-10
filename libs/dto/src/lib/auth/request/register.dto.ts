import {
  DtoPrefix,
  getValidationMessage,
  normalizeTrMobilePhone,
  TR_MOBILE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { auth } from '@libs/proto';
import { Transform } from 'class-transformer';
import { FullName } from '../../shared/full-name.decorator';
import {
  AccountEmail,
  AccountPassword,
} from '../../shared/account-fields.decorator';
import { IsIn, Matches } from 'class-validator';

export class RegisterRequestDto implements auth.RegisterRequest {
  @AccountEmail()
  email!: string;

  @AccountPassword()
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
