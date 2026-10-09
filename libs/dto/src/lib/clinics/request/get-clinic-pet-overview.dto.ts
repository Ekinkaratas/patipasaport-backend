import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { clinics } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class GetClinicPetOverviewRequestDto
  implements clinics.GetClinicPetOverviewRequest
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
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PET_ID, ValidationType.NOT_EMPTY),
  })
  petId!: string;
}
