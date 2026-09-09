import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Yapı: harf bloğu + (ayraç + harf bloğu)*
 * Bu kurgu "Ali  Veli" (çift boşluk), "-Ahmet" (baştan ayraç) ve
 * "Mehmet " (sondan ayraç) durumlarını reddeder.
 * Her tekrar mutlaka bir ayraçla başladığı için belirsizlik yoktur,
 * katastrofik geri izleme (ReDoS) riski taşımaz.
 */
const FULL_NAME_PATTERN =
  /^[a-zA-ZçğıöşüÇĞİÖŞÜ]+(?:[ '-][a-zA-ZçğıöşüÇĞİÖŞÜ]+)*$/;

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/;

/**
 * Kabul edilen yazımlar: 5551234567 / 05551234567 / +905551234567
 * '5' zorunluluğu sabit hatları eler, sadece cep telefonu bırakır.
 *
 * "0555 123 45 67" aradaki boşluklar yüzünden reddedilir — frontend'de normalize edilmeli.
 */
const PHONE_PATTERN = /^(?:\+90|0)?5\d{9}$/;

export class RegisterRequestDto implements auth.RegisterRequest {
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
  @MinLength(8, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MIN_LENGTH,
      8,
    ),
  })
  @MaxLength(72, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.MAX_LENGTH,
      72,
    ),
  })
  @Matches(PASSWORD_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.PASSWORD,
      ValidationType.WEAK_PASSWORD,
    ),
  })
  password!: string;

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

  @IsIn([auth.ClientType.WEB, auth.ClientType.MOBILE], {
    message: getValidationMessage(
      DtoPrefix.CLIENT_TYPE,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clientType!: auth.ClientType;
}
