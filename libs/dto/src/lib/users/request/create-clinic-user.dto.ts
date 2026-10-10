import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { AccountEmail } from '../../shared/account-fields.decorator';
import {
  ClinicName,
  ClinicPhone,
} from '../../shared/clinic-fields.decorator';

export class CreateClinicUserRequestDto
  implements users.CreateClinicUserRequest
{
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.USER_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.USER_ID, ValidationType.NOT_EMPTY),
  })
  id!: string;

  @AccountEmail()
  email!: string;

  @ClinicName()
  fullName!: string;

  @ClinicPhone()
  phone!: string;

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
}
