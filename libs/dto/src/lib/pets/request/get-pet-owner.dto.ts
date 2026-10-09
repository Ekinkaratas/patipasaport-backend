import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { pets } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class GetPetOwnerRequestDto implements pets.GetPetOwnerRequest {
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
