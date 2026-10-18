import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { clinics } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class DeleteStockItemRequestDto
  implements clinics.DeleteStockItemRequest
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
}
