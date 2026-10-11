import { DtoPrefix } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { MedicalUuid } from '../../shared/medical-fields.decorator';

export class GetDocumentRequestDto implements medicalRecord.GetDocumentRequest {
  @MedicalUuid(DtoPrefix.DOCUMENT_ID, 'required')
  id!: string;
}
