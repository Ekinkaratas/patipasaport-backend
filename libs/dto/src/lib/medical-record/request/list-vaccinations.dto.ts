import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  MedicalUuid,
  OptionalBooleanFilter,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';

export class ListVaccinationsRequestDto
  implements medicalRecord.ListVaccinationsRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @OptionalBooleanFilter(DtoPrefix.ONLY_UPCOMING)
  onlyUpcoming?: boolean | undefined;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
