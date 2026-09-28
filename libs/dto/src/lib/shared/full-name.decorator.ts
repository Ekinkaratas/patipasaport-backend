import { applyDecorators } from '@nestjs/common';
import {
  DtoPrefix,
  getValidationMessage,
  normalizeWhitespace,
  ValidationType,
} from '@libs/common';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Yapı: harf bloğu + (ayraç + harf bloğu)+  -> en az iki kelime (ad + soyad).
 * "-Ahmet" (baştan ayraç) ve "Mehmet-" (sondan ayraç) reddedilir; fazla
 * boşluklar normalizeWhitespace ile doğrulamadan önce temizlenir.
 * Her tekrar mutlaka bir ayraçla başladığı için belirsizlik yoktur,
 * katastrofik geri izleme (ReDoS) riski taşımaz.
 */
export const FULL_NAME_PATTERN =
  /^[a-zA-ZçğıöşüâîûÇĞİÖŞÜÂÎÛ]+(?:[ '-][a-zA-ZçğıöşüâîûÇĞİÖŞÜÂÎÛ]+)+$/;

export const FULL_NAME_MIN_LENGTH = 5;
/** users.full_name kolonu varchar(64) ile aynı. */
export const FULL_NAME_MAX_LENGTH = 64;

/**
 * Register, CreateUser ve UpdateMe'nin ORTAK ad soyad kuralı. Register'dan
 * geçen her isim CreateUser'da da geçmeli — kural tek yerde tutulur.
 *
 * applyDecorators dekoratörleri dizi sırasıyla uygular ve class-validator
 * onları UYGULANDIĞI sırayla çalıştırır; stopAtFirstError ile ilk hata döndüğü
 * için dizi "boş mu → tip → min → max → format" sırasındadır.
 */
export function FullName(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeWhitespace(value)),
    IsNotEmpty({
      message: getValidationMessage(DtoPrefix.NAME, ValidationType.NOT_EMPTY),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.NAME,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    MinLength(FULL_NAME_MIN_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.NAME,
        ValidationType.MIN_LENGTH,
        FULL_NAME_MIN_LENGTH,
      ),
    }),
    MaxLength(FULL_NAME_MAX_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.NAME,
        ValidationType.MAX_LENGTH,
        FULL_NAME_MAX_LENGTH,
      ),
    }),
    Matches(FULL_NAME_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.NAME,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    }),
  );
}
