import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { MedicalUuid } from '../../shared/medical-fields.decorator';

export class GetLabExplanationRequestDto
  implements medicalRecord.GetLabExplanationRequest
{
  @MedicalUuid(DtoPrefix.RECORD_ID, 'required')
  recordId!: string;
}
