import { applyDecorators } from '@nestjs/common';
import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { Transform } from 'class-transformer';
import { IsNumber, Max, Min, ValidateIf } from 'class-validator';

export const STOCK_PRICE_MAX = 1_000_000_000;

export function StockPrice(
  prefix: DtoPrefix,
  mode: 'required' | 'optional',
): PropertyDecorator {
  return applyDecorators(
    ...(mode === 'optional'
      ? [ValidateIf((_object: object, value: unknown) => value !== undefined)]
      : []),
    Transform(({ value }) =>
      typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
    ),
    IsNumber(
      {
        allowNaN: false,
        allowInfinity: false,
        maxDecimalPlaces: 0,
      },
      {
        message: getValidationMessage(prefix, ValidationType.MUST_BE_NUMBER),
      },
    ),
    Min(0, {
      message: getValidationMessage(prefix, ValidationType.MIN, 0),
    }),
    Max(STOCK_PRICE_MAX, {
      message: getValidationMessage(
        prefix,
        ValidationType.MAX,
        STOCK_PRICE_MAX,
      ),
    }),
  );
}
