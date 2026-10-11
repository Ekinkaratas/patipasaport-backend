import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  MedicalText,
  MedicalUuid,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';
import { MEDICAL_NAME_MAX_LENGTH } from './record-content.dto';

export class ListLabResultsRequestDto
  implements medicalRecord.ListLabResultsRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @MedicalText(DtoPrefix.TEST_NAME, {
    presence: 'optional',
    maxLength: MEDICAL_NAME_MAX_LENGTH,
  })
  testName?: string | undefined;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
