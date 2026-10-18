import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { MedicalUuid } from '../../shared/medical-fields.decorator';

export class GetDocumentRequestDto implements medicalRecord.GetDocumentRequest {
  @MedicalUuid(DtoPrefix.DOCUMENT_ID, 'required')
  id!: string;
}

export class GetDocumentFileRequestDto extends GetDocumentRequestDto {
  @IsIn([true], {
    message: getValidationMessage(DtoPrefix.DOWNLOAD, ValidationType.NOT_VALID),
  })
  @IsOptional()
  @Transform(({ value }) => (value === '1' ? true : value))
  download?: boolean;
}
