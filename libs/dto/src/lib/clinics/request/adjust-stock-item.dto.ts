import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { clinics } from '@libs/proto';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsUUID,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { STOCK_AMOUNT_MAX } from './add-stock-item.dto';

export class AdjustStockItemRequestDto
  implements clinics.AdjustStockItemRequest
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

  @ValidateBy(
    {
      name: 'isNotZero',
      validator: { validate: (value: unknown) => value !== 0 },
    },
    {
      message: getValidationMessage(DtoPrefix.DELTA, ValidationType.NOT_VALID),
    },
  )
  @Type(() => Number)
  @Max(STOCK_AMOUNT_MAX, {
    message: getValidationMessage(
      DtoPrefix.DELTA,
      ValidationType.MAX,
      STOCK_AMOUNT_MAX,
    ),
  })
  @Min(-STOCK_AMOUNT_MAX, {
    message: getValidationMessage(
      DtoPrefix.DELTA,
      ValidationType.MIN,
      -STOCK_AMOUNT_MAX,
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
        DtoPrefix.DELTA,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  delta!: number;
}
