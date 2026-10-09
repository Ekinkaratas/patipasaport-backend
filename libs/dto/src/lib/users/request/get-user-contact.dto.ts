import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { users } from '@libs/proto';

export class GetUserContactRequestDto implements users.GetUserContactRequest {
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

  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PET_ID, ValidationType.NOT_EMPTY),
  })
  petId!: string;
}
