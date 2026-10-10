import { clinics } from '@libs/proto';
import {
  AccountEmail,
  AccountPassword,
} from '../../shared/account-fields.decorator';
import {
  ClinicName,
  ClinicPhone,
  TaxNumber,
} from '../../shared/clinic-fields.decorator';

export class CreateClinicRequestDto implements clinics.CreateClinicRequest {
  @ClinicName()
  name!: string;

  @TaxNumber()
  taxNumber!: string;

  @ClinicPhone()
  phone!: string;

  @AccountEmail()
  email!: string;

  @AccountPassword()
  password!: string;
}
