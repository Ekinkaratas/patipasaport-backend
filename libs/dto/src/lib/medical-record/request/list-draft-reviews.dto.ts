import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import {
  MedicalUuid,
  OptionalNumericEnum,
  PageNumber,
  PageSize,
} from '../../shared/medical-fields.decorator';

export const DRAFT_REVIEW_STATUSES = [
  medicalRecord.DraftReviewStatus.PENDING,
  medicalRecord.DraftReviewStatus.APPROVED,
  medicalRecord.DraftReviewStatus.REJECTED,
] as const;

export class ListDraftReviewsRequestDto
  implements medicalRecord.ListDraftReviewsRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'optional')
  petId?: string | undefined;

  @OptionalNumericEnum(DtoPrefix.DRAFT_REVIEW_STATUS, DRAFT_REVIEW_STATUSES)
  status?: medicalRecord.DraftReviewStatus | undefined;

  @PageNumber()
  page!: number;

  @PageSize()
  pageSize!: number;
}
