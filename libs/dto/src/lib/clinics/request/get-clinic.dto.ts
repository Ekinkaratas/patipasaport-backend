import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { clinics } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class GetClinicRequestDto implements clinics.GetClinicRequest {
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
  id!: string;
}
