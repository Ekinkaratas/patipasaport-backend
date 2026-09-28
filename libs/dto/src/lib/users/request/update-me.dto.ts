import {
  DtoPrefix,
  getValidationMessage,
  normalizeTrMobilePhone,
  TR_MOBILE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { users } from '@libs/proto';
import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';
import { FullName } from '../../shared/full-name.decorator';

export class UpdateUserRequestDto implements users.UpdateMeRequest {
  @IsOptional()
  @FullName()
  fullName?: string | undefined;

  // Girdi: 5551234567 / 05551234567 / +905551234567 / "0555 123 45 67"
  // Çıktı (DB'ye giden): +905551234567
  @IsOptional()
  @Transform(({ value }) => normalizeTrMobilePhone(value))
  @Matches(TR_MOBILE_E164_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.PHONE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  phone?: string | undefined;
}
