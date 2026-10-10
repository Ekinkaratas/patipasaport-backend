import { applyDecorators } from '@nestjs/common';
import {
  DtoPrefix,
  getValidationMessage,
  normalizeEmail,
  ValidationType,
} from '@libs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const ACCOUNT_EMAIL_MAX_LENGTH = 254;
export const ACCOUNT_PASSWORD_PATTERN =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/;
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 72;

export function AccountEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeEmail(value)),
    IsNotEmpty({
      message: getValidationMessage(DtoPrefix.EMAIL, ValidationType.NOT_EMPTY),
    }),
    MaxLength(ACCOUNT_EMAIL_MAX_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.EMAIL,
        ValidationType.MAX_LENGTH,
        ACCOUNT_EMAIL_MAX_LENGTH,
      ),
    }),
    IsEmail(
      {},
      {
        message: getValidationMessage(
          DtoPrefix.EMAIL,
          ValidationType.WRONG_DATA_FORMAT,
        ),
      },
    ),
  );
}

export function AccountPassword(): PropertyDecorator {
  return applyDecorators(
    IsNotEmpty({
      message: getValidationMessage(
        DtoPrefix.PASSWORD,
        ValidationType.NOT_EMPTY,
      ),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.PASSWORD,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    MinLength(ACCOUNT_PASSWORD_MIN_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.PASSWORD,
        ValidationType.MIN_LENGTH,
        ACCOUNT_PASSWORD_MIN_LENGTH,
      ),
    }),
    MaxLength(ACCOUNT_PASSWORD_MAX_LENGTH, {
      message: getValidationMessage(
        DtoPrefix.PASSWORD,
        ValidationType.MAX_LENGTH,
        ACCOUNT_PASSWORD_MAX_LENGTH,
      ),
    }),
    Matches(ACCOUNT_PASSWORD_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.PASSWORD,
        ValidationType.WEAK_PASSWORD,
      ),
    }),
  );
}
