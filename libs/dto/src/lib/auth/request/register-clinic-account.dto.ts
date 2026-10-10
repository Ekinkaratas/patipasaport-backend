import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { auth } from '@libs/proto';
import { IsNotEmpty, IsUUID } from 'class-validator';
import {
  AccountEmail,
  AccountPassword,
} from '../../shared/account-fields.decorator';
import {
  ClinicName,
  ClinicPhone,
} from '../../shared/clinic-fields.decorator';

export class RegisterClinicAccountRequestDto
  implements auth.RegisterClinicAccountRequest
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

  @AccountEmail()
  email!: string;

  @AccountPassword()
  password!: string;

  @ClinicName()
  fullName!: string;

  @ClinicPhone()
  phone!: string;
}
