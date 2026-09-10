import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import {
  IsEmail,
  IsNotEmpty,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const FULL_NAME_PATTERN =
  /^[a-zA-ZçğıöşüÇĞİÖŞÜ]+(?:[ '-][a-zA-ZçğıöşüÇĞİÖŞÜ]+)*$/;

// * Kabul edilen yazımlar: 5551234567 / 05551234567 / +905551234567
const PHONE_PATTERN = /^(?:\+90|0)?5\d{9}$/;

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
  fullName!: string;

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
  phone!: string;
}
