import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { access } from '@libs/proto';
import { IsUUID } from 'class-validator';

export class GetConsentStatusRequestDto
  implements access.GetConsentStatusRequest
{
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  clinicId!: string;

  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  petId!: string;
}
