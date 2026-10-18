import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { clinics } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DateAfter,
  MedicalDate,
  MedicalUuid,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';
import { STOCK_AMOUNT_MAX } from './add-stock-item.dto';
import { StockPrice } from './stock-price.decorator';

export const SALES_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateStockSaleRequestDto
  implements clinics.CreateStockSaleRequest
{
  @MedicalUuid(DtoPrefix.CLINIC_ID, 'required')
  clinicId!: string;

  @MedicalUuid(DtoPrefix.STOCK_ITEM_ID, 'required')
  itemId!: string;

  @Type(() => Number)
  @Max(STOCK_AMOUNT_MAX, {
    message: getValidationMessage(
      DtoPrefix.QUANTITY,
      ValidationType.MAX,
      STOCK_AMOUNT_MAX,
    ),
  })
  @Min(1, {
    message: getValidationMessage(DtoPrefix.QUANTITY, ValidationType.MIN, 1),
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

  @StockPrice(DtoPrefix.UNIT_PRICE, 'optional')
  unitPrice?: number;
}

export class CancelStockSaleRequestDto
  implements clinics.CancelStockSaleRequest
{
  @MedicalUuid(DtoPrefix.CLINIC_ID, 'required')
  clinicId!: string;

  @MedicalUuid(DtoPrefix.SALE_ID, 'required')
  saleId!: string;
}

export class ListStockSalesRequestDto implements clinics.ListStockSalesRequest {
  @MedicalUuid(DtoPrefix.CLINIC_ID, 'required')
  clinicId!: string;

  @MedicalDate(DtoPrefix.FROM_DATE, { presence: 'optional' })
  fromDate!: string;

  @DateAfter(DtoPrefix.TO_DATE, 'fromDate', true)
  @MedicalDate(DtoPrefix.TO_DATE, { presence: 'optional' })
  toDate!: string;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}

export class GetStockSalesSummaryRequestDto
  implements clinics.GetStockSalesSummaryRequest
{
  @MedicalUuid(DtoPrefix.CLINIC_ID, 'required')
  clinicId!: string;

  @Matches(SALES_MONTH_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.MONTH,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.MONTH,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? undefined : trimmed;
  })
  month!: string;
}
