import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const FULL_NAME_PATTERN =
  /^[a-zA-ZçğıöşüÇĞİÖŞÜ]+(?:[ '-][a-zA-ZçğıöşüÇĞİÖŞÜ]+)*$/;

// Kabul edilen yazımlar: 5551234567 / 05551234567 / +905551234567
const PHONE_PATTERN = /^(?:\+90|0)?5\d{9}$/;

const CITY_DISTRICT_PATTERN =
  /^[a-zA-ZçğıöşüÇĞİÖŞÜ]+(?:[ -][a-zA-ZçğıöşüÇĞİÖŞÜ]+)*$/;

export class UpdateUserRequestDto implements users.UpdateMeRequest {
  @IsOptional()
  @IsString({
    message: getValidationMessage(
      DtoPrefix.NAME,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @MinLength(4, {
    message: getValidationMessage(DtoPrefix.NAME, ValidationType.MIN_LENGTH, 4),
  })
  @MaxLength(64, {
    message: getValidationMessage(
      DtoPrefix.NAME,
      ValidationType.MAX_LENGTH,
      64,
    ),
  })
  @Matches(FULL_NAME_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.NAME,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  fullName?: string | undefined;

  @IsOptional()
  @IsPhoneNumber('TR', {
    message: getValidationMessage(
      DtoPrefix.PHONE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @Matches(PHONE_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.PHONE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  phone?: string | undefined;

  @IsOptional()
  @IsString({
    message: getValidationMessage(
      DtoPrefix.ADDRESS_LINE,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @MinLength(5, {
    message: getValidationMessage(
      DtoPrefix.ADDRESS_LINE,
      ValidationType.MIN_LENGTH,
      5,
    ),
  })
  @MaxLength(200, {
    message: getValidationMessage(
      DtoPrefix.ADDRESS_LINE,
      ValidationType.MAX_LENGTH,
      200,
    ),
  })
  @ValidateIf((o) => o.addressLine !== '')
  addressLine?: string | undefined;

  @IsOptional()
  @IsString({
    message: getValidationMessage(
      DtoPrefix.CITY,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @MinLength(2, {
    message: getValidationMessage(DtoPrefix.CITY, ValidationType.MIN_LENGTH, 2),
  })
  @MaxLength(50, {
    message: getValidationMessage(
      DtoPrefix.CITY,
      ValidationType.MAX_LENGTH,
      50,
    ),
  })
  @Matches(CITY_DISTRICT_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.CITY,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @ValidateIf((o) => o.city !== '')
  city?: string | undefined;

  @IsOptional()
  @IsString({
    message: getValidationMessage(
      DtoPrefix.DISTRICT,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @MinLength(2, {
    message: getValidationMessage(
      DtoPrefix.DISTRICT,
      ValidationType.MIN_LENGTH,
      2,
    ),
  })
  @MaxLength(50, {
    message: getValidationMessage(
      DtoPrefix.DISTRICT,
      ValidationType.MAX_LENGTH,
      50,
    ),
  })
  @Matches(CITY_DISTRICT_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.DISTRICT,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @ValidateIf((o) => o.district !== '')
  district?: string | undefined;
}
