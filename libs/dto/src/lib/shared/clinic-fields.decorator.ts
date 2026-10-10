import { applyDecorators } from '@nestjs/common';
import {
  DtoPrefix,
  getValidationMessage,
  isValidTrTaxNumber,
  normalizeTrPhone,
  normalizeWhitespace,
  TR_PHONE_E164_PATTERN,
  ValidationType,
} from '@libs/common';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateBy,
} from 'class-validator';

export const CLINIC_NAME_PATTERN =
  /^(?=.*[a-zA-ZçğıöşüâîûÇĞİÖŞÜÂÎÛ])[a-zA-Z0-9çğıöşüâîûÇĞİÖŞÜÂÎÛ .'&-]+$/;
export const CLINIC_NAME_MIN_LENGTH = 2;
export const CLINIC_NAME_MAX_LENGTH = 64;
export const TAX_NUMBER_PATTERN = /^\d{10,11}$/;

export function ClinicName(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeWhitespace(value)),
    IsNotEmpty({
      message: getValidationMessage(
        DtoPrefix.CLINIC_NAME,
        ValidationType.NOT_EMPTY,
      ),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.CLINIC_NAME,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    MinLength(CLINIC_NAME_MIN_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.CLINIC_NAME,
        ValidationType.MIN_LENGTH,
        CLINIC_NAME_MIN_LENGTH,
      ),
    }),
    MaxLength(CLINIC_NAME_MAX_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.CLINIC_NAME,
        ValidationType.MAX_LENGTH,
        CLINIC_NAME_MAX_LENGTH,
      ),
    }),
    Matches(CLINIC_NAME_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.CLINIC_NAME,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    }),
  );
}

export function TaxNumber(): PropertyDecorator {
  return applyDecorators(
    IsNotEmpty({
      message: getValidationMessage(
        DtoPrefix.TAX_NUMBER,
        ValidationType.NOT_EMPTY,
      ),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.TAX_NUMBER,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    Matches(TAX_NUMBER_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.TAX_NUMBER,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    }),
    ValidateBy(
      {
        name: 'isTrTaxNumber',
        validator: {
          validate: (value: unknown) => isValidTrTaxNumber(value),
        },
      },
      {
        message: getValidationMessage(
          DtoPrefix.TAX_NUMBER,
          ValidationType.NOT_VALID,
        ),
      },
    ),
  );
}

export function ClinicPhone(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeTrPhone(value)),
    Matches(TR_PHONE_E164_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.PHONE,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    }),
  );
}
