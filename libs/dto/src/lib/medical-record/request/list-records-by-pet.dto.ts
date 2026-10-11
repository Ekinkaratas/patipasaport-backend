import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  DateAfter,
  MedicalDate,
  MedicalUuid,
  OptionalNumericEnum,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';
import { MEDICAL_RECORD_TYPES } from './record-content.dto';

export class ListRecordsByPetRequestDto
  implements medicalRecord.ListRecordsByPetRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @OptionalNumericEnum(DtoPrefix.RECORD_TYPE, MEDICAL_RECORD_TYPES)
  type?: medicalRecord.RecordType | undefined;

  @MedicalDate(DtoPrefix.FROM_DATE, { presence: 'optional' })
  fromDate!: string;

  @DateAfter(DtoPrefix.TO_DATE, 'fromDate', true)
  @MedicalDate(DtoPrefix.TO_DATE, { presence: 'optional' })
  toDate!: string;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
