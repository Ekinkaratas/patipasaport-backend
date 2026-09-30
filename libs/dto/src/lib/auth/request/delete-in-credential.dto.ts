import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class DeleteInCredentialRequestDto {
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.USER_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.USER_ID, ValidationType.NOT_EMPTY),
  })
  userId!: string;
}
