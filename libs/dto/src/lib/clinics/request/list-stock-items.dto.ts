import {
  DtoPrefix,
  getValidationMessage,
  STOCK_CATEGORIES,
  ValidationType,
} from '@libs/common';
import { clinics } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export class ListStockItemsRequestDto implements clinics.ListStockItemsRequest {
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

  @Type(() => Number)
  @Min(1, {
    message: getValidationMessage(DtoPrefix.PAGE, ValidationType.MIN, 1),
  })
  @IsNumber(
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
  )
  page!: number;

  @Type(() => Number)
  @IsIn([8, 16, 32, 64, 128], {
    message: getValidationMessage(
      DtoPrefix.PAGE_SIZE,
      ValidationType.NOT_VALID,
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
        DtoPrefix.PAGE_SIZE,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  pageSize!: number;

  @IsIn(STOCK_CATEGORIES, {
    message: getValidationMessage(DtoPrefix.CATEGORY, ValidationType.NOT_VALID),
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  category?: string | undefined;

  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.ONLY_BELOW_CRITICAL,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsOptional()
  onlyBelowCritical?: boolean | undefined;
}
