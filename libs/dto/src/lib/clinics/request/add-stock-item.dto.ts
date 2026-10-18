import {
  DtoPrefix,
  getValidationMessage,
  normalizeWhitespace,
  STOCK_CATEGORIES,
  STOCK_UNITS,
  ValidationType,
} from '@libs/common';
import { clinics } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';
import {
  DATE_ONLY_PATTERN,
  todayInBusinessTimeZone,
} from '../../shared/pet-fields.decorator';
import { StockPrice } from './stock-price.decorator';

export const STOCK_NAME_PATTERN =
  /^[a-zA-Z0-9çğıöşüâîûÇĞİÖŞÜÂÎÛ.,%()+/-]+(?: [a-zA-Z0-9çğıöşüâîûÇĞİÖŞÜÂÎÛ.,%()+/-]+)*$/;
export const STOCK_NAME_MAX_LENGTH = 64;
export const STOCK_AMOUNT_MAX = 100_000;

export class AddStockItemRequestDto implements clinics.AddStockItemRequest {
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
  @Transform(({ value }) => normalizeWhitespace(value))
  name!: string;

  @IsIn(STOCK_CATEGORIES, {
    message: getValidationMessage(DtoPrefix.CATEGORY, ValidationType.NOT_VALID),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.CATEGORY, ValidationType.NOT_EMPTY),
  })
  category!: string;

  @IsIn(STOCK_UNITS, {
    message: getValidationMessage(DtoPrefix.UNIT, ValidationType.NOT_VALID),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.UNIT, ValidationType.NOT_EMPTY),
  })
  unit!: string;

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
  quantity!: number;

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
  criticalLevel!: number;

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
  @IsOptional()
  @Transform(({ value }) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? undefined : trimmed;
  })
  expiresAt!: string;

  @StockPrice(DtoPrefix.PURCHASE_PRICE, 'required')
  purchasePrice!: number;

  @StockPrice(DtoPrefix.SALE_PRICE, 'required')
  salePrice!: number;
}
