import {
  DtoPrefix,
  getValidationMessage,
  normalizeWhitespace,
  ValidationType,
} from '@libs/common';
import { clinics } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  DATE_ONLY_PATTERN,
  todayInBusinessTimeZone,
} from '../../shared/pet-fields.decorator';
import {
  STOCK_AMOUNT_MAX,
  STOCK_NAME_MAX_LENGTH,
  STOCK_NAME_PATTERN,
} from './add-stock-item.dto';
import { StockPrice } from './stock-price.decorator';

const isProvided = (_object: object, value: unknown): boolean =>
  value !== undefined;

export class UpdateStockItemRequestDto
  implements clinics.UpdateStockItemRequest
{
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.NOT_EMPTY,
    ),
  })
  clinicId!: string;

  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.STOCK_ITEM_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.STOCK_ITEM_ID,
      ValidationType.NOT_EMPTY,
    ),
  })
  itemId!: string;

  @Matches(STOCK_NAME_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.STOCK_NAME,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @MaxLength(STOCK_NAME_MAX_LENGTH, {
    message: getValidationMessage(
      DtoPrefix.STOCK_NAME,
      ValidationType.MAX_LENGTH,
      STOCK_NAME_MAX_LENGTH,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.STOCK_NAME,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.STOCK_NAME,
      ValidationType.NOT_EMPTY,
    ),
  })
  @ValidateIf(isProvided)
  @Transform(({ value }) => normalizeWhitespace(value))
  name?: string;

  @Type(() => Number)
  @Max(STOCK_AMOUNT_MAX, {
    message: getValidationMessage(
      DtoPrefix.QUANTITY,
      ValidationType.MAX,
      STOCK_AMOUNT_MAX,
    ),
  })
  @Min(0, {
    message: getValidationMessage(DtoPrefix.QUANTITY, ValidationType.MIN, 0),
  })
  @IsNumber(
    {
      allowNaN: false,
      allowInfinity: false,
      maxDecimalPlaces: 0,
    },
    {
      message: getValidationMessage(
        DtoPrefix.QUANTITY,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  @ValidateIf(isProvided)
  quantity?: number;

  @Type(() => Number)
  @Max(STOCK_AMOUNT_MAX, {
    message: getValidationMessage(
      DtoPrefix.CRITICAL_LEVEL,
      ValidationType.MAX,
      STOCK_AMOUNT_MAX,
    ),
  })
  @Min(0, {
    message: getValidationMessage(
      DtoPrefix.CRITICAL_LEVEL,
      ValidationType.MIN,
      0,
    ),
  })
  @IsNumber(
    {
      allowNaN: false,
      allowInfinity: false,
      maxDecimalPlaces: 0,
    },
    {
      message: getValidationMessage(
        DtoPrefix.CRITICAL_LEVEL,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  @ValidateIf(isProvided)
  criticalLevel?: number;

  @ValidateBy(
    {
      name: 'isNotPastDate',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && value >= todayInBusinessTimeZone(),
      },
    },
    {
      message: getValidationMessage(
        DtoPrefix.EXPIRES_AT,
        ValidationType.CANNOT_BE_PAST,
      ),
    },
  )
  @IsDateString(
    { strict: true },
    {
      message: getValidationMessage(
        DtoPrefix.EXPIRES_AT,
        ValidationType.MUST_BE_DATE,
      ),
    },
  )
  @Matches(DATE_ONLY_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.EXPIRES_AT,
      ValidationType.MUST_BE_DATE,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.EXPIRES_AT,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @ValidateIf((_object, value) => value !== undefined && value !== '')
  @Transform(({ value }) => {
    if (value === null) return '';
    return typeof value === 'string' ? value.trim() : value;
  })
  expiresAt?: string;

  @StockPrice(DtoPrefix.PURCHASE_PRICE, 'optional')
  purchasePrice?: number;

  @StockPrice(DtoPrefix.SALE_PRICE, 'optional')
  salePrice?: number;
}
