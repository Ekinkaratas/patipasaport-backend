import { applyDecorators } from '@nestjs/common';
import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidationArguments,
} from 'class-validator';
import {
  DATE_ONLY_PATTERN,
  todayInBusinessTimeZone,
} from './pet-fields.decorator';

export type MedicalFieldPresence = 'required' | 'optional';

export interface MedicalTextOptions {
  presence: MedicalFieldPresence;
  maxLength: number;
  minLength?: number;
  multiline?: boolean;
}

export interface MedicalDateOptions {
  presence: MedicalFieldPresence;
  notFuture?: boolean;
}

export const MEDICAL_PAGE_SIZES = [8, 16, 32, 64, 128] as const;

const isControlCharacter = (code: number): boolean =>
  code < 0x20 || code === 0x7f;

const isLineBreak = (code: number): boolean => code === 0x0a || code === 0x0d;

export const isPlainText = (value: unknown): boolean =>
  typeof value === 'string' &&
  [...value].every((char) => !isControlCharacter(char.charCodeAt(0)));

export const isPlainMultilineText = (value: unknown): boolean =>
  typeof value === 'string' &&
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return isLineBreak(code) || !isControlCharacter(code);
  });

const trim = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

const emptyAsAbsent = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

function presence(
  mode: MedicalFieldPresence,
  normalize: (value: unknown) => unknown,
): PropertyDecorator[] {
  if (mode === 'optional') {
    return [
      Transform(({ value }) => emptyAsAbsent(normalize(value))),
      IsOptional(),
    ];
  }
  return [Transform(({ value }) => normalize(value))];
}

export function MedicalText(
  prefix: DtoPrefix,
  {
    presence: mode,
    maxLength,
    minLength,
    multiline = false,
  }: MedicalTextOptions,
): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, trim),
    IsNotEmpty({
      message: getValidationMessage(prefix, ValidationType.NOT_EMPTY),
    }),
    IsString({
      message: getValidationMessage(prefix, ValidationType.MUST_BE_STRING),
    }),
    ...(minLength === undefined
      ? []
      : [
          MinLength(minLength, {
            message: getValidationMessage(
              prefix,
              ValidationType.MIN_LENGTH,
              minLength,
            ),
          }),
        ]),
    MaxLength(maxLength, {
      message: getValidationMessage(
        prefix,
        ValidationType.MAX_LENGTH,
        maxLength,
      ),
    }),
    ValidateBy(
      {
        name: multiline ? 'isPlainMultilineText' : 'isPlainText',
        validator: {
          validate: multiline ? isPlainMultilineText : isPlainText,
        },
      },
      {
        message: getValidationMessage(prefix, ValidationType.WRONG_DATA_FORMAT),
      },
    ),
  );
}

export function MedicalDate(
  prefix: DtoPrefix,
  { presence: mode, notFuture = false }: MedicalDateOptions,
): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, trim),
    IsNotEmpty({
      message: getValidationMessage(prefix, ValidationType.NOT_EMPTY),
    }),
    IsString({
      message: getValidationMessage(prefix, ValidationType.MUST_BE_STRING),
    }),
    Matches(DATE_ONLY_PATTERN, {
      message: getValidationMessage(prefix, ValidationType.MUST_BE_DATE),
    }),
    IsDateString(
      { strict: true },
      {
        message: getValidationMessage(prefix, ValidationType.MUST_BE_DATE),
      },
    ),
    ...(notFuture
      ? [
          ValidateBy(
            {
              name: 'isNotFutureDate',
              validator: {
                validate: (value: unknown) =>
                  typeof value === 'string' &&
                  value <= todayInBusinessTimeZone(),
              },
            },
            {
              message: getValidationMessage(
                prefix,
                ValidationType.CANNOT_BE_FUTURE,
              ),
            },
          ),
        ]
      : []),
  );
}

export function DateAfter(
  prefix: DtoPrefix,
  otherProperty: string,
  allowEqual: boolean,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDateAfter',
      validator: {
        validate: (value: unknown, args?: ValidationArguments) => {
          const other = (args?.object as Record<string, unknown> | undefined)?.[
            otherProperty
          ];
          if (typeof other !== 'string' || !DATE_ONLY_PATTERN.test(other)) {
            return true;
          }
          if (typeof value !== 'string') return false;
          return allowEqual ? value >= other : value > other;
        },
      },
    },
    {
      message: getValidationMessage(prefix, ValidationType.NOT_VALID),
    },
  );
}

export function MedicalUuid(
  prefix: DtoPrefix,
  mode: MedicalFieldPresence,
): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, trim),
    IsNotEmpty({
      message: getValidationMessage(prefix, ValidationType.NOT_EMPTY),
    }),
    IsUUID('4', {
      message: getValidationMessage(prefix, ValidationType.WRONG_DATA_FORMAT),
    }),
  );
}

export function OptionalNumericEnum(
  prefix: DtoPrefix,
  values: readonly number[],
): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => {
      const normalized = emptyAsAbsent(trim(value));
      return typeof normalized === 'string' ? Number(normalized) : normalized;
    }),
    IsOptional(),
    IsIn(values, {
      message: getValidationMessage(prefix, ValidationType.NOT_VALID),
    }),
  );
}

export function OptionalBooleanFilter(prefix: DtoPrefix): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) =>
      value === 'true' ? true : value === 'false' ? false : value,
    ),
    IsOptional(),
    IsBoolean({
      message: getValidationMessage(prefix, ValidationType.MUST_BE_BOOLEAN),
    }),
  );
}

export function PageNumber(): PropertyDecorator {
  return applyDecorators(
    Type(() => Number),
    IsNumber(
      {
        allowNaN: false,
        allowInfinity: false,
        maxDecimalPlaces: 0,
      },
      {
        message: getValidationMessage(
          DtoPrefix.PAGE,
          ValidationType.MUST_BE_NUMBER,
        ),
      },
    ),
    Min(1, {
      message: getValidationMessage(DtoPrefix.PAGE, ValidationType.MIN, 1),
    }),
  );
}

export function PageSize(): PropertyDecorator {
  return applyDecorators(
    Type(() => Number),
    IsNumber(
      {
        allowNaN: false,
        allowInfinity: false,
        maxDecimalPlaces: 0,
      },
      {
        message: getValidationMessage(
          DtoPrefix.PAGE_SIZE,
          ValidationType.MUST_BE_NUMBER,
        ),
      },
    ),
    IsIn(MEDICAL_PAGE_SIZES, {
      message: getValidationMessage(
        DtoPrefix.PAGE_SIZE,
        ValidationType.NOT_VALID,
      ),
    }),
  );
}
