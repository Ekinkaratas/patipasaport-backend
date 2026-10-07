import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { access } from '@libs/proto';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, Min } from 'class-validator';

export class ListMyConsentsRequestDto implements access.ListMyConsentsRequest {
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
}
