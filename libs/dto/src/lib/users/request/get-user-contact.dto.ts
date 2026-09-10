import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { users } from '@libs/proto';

// owner_contact_read scope'u ile kullanılacak
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
}
