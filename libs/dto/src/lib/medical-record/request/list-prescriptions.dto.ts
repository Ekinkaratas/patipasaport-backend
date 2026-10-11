import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  MedicalUuid,
  OptionalBooleanFilter,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';

export class ListPrescriptionsRequestDto
  implements medicalRecord.ListPrescriptionsRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @OptionalBooleanFilter(DtoPrefix.ONLY_ACTIVE)
  onlyActive?: boolean | undefined;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
