import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { MedicalUuid } from '../../shared/medical-fields.decorator';

export class RequestHealthAssessmentRequestDto
  implements medicalRecord.RequestHealthAssessmentRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;
}

export class GetLatestHealthAssessmentRequestDto
  implements medicalRecord.GetLatestHealthAssessmentRequest
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;
}
