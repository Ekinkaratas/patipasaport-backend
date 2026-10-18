import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  MedicalUuid,
  OptionalNumericEnum,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';

export const DOCUMENT_STATUSES = [
  medicalRecord.DocumentStatus.QUEUED,
  medicalRecord.DocumentStatus.PROCESSING,
  medicalRecord.DocumentStatus.DRAFT_READY,
  medicalRecord.DocumentStatus.FAILED,
] as const;

export class ListDocumentsByPetRequestDto
  implements medicalRecord.ListDocumentsByPetRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @OptionalNumericEnum(DtoPrefix.DOCUMENT_STATUS, DOCUMENT_STATUSES)
  status?: medicalRecord.DocumentStatus | undefined;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
