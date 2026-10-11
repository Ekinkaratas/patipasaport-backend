import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { MedicalUuid } from '../../shared/medical-fields.decorator';
import { RecordContentDto } from './record-content.dto';

export const RECORD_ATTACHMENTS_MAX = 10;

export class AttachmentReferenceDto
  implements Pick<medicalRecord.FileReference, 'documentId'>
{
  @MedicalUuid(DtoPrefix.DOCUMENT_ID, 'required')
  documentId!: string;
}

export class CreateRecordRequestDto
  implements Omit<medicalRecord.CreateRecordRequest, 'attachments'>
{
  @MedicalUuid(DtoPrefix.PET_ID, 'required')
  petId!: string;

  @ValidateNested()
  @ArrayUnique(
    (attachment: AttachmentReferenceDto | undefined) => attachment?.documentId,
    {
      message: getValidationMessage(
        DtoPrefix.ATTACHMENTS,
        ValidationType.MUST_BE_UNIQUE,
      ),
    },
  )
  @ArrayMaxSize(RECORD_ATTACHMENTS_MAX, {
    message: getValidationMessage(
      DtoPrefix.ATTACHMENTS,
      ValidationType.MAX,
      RECORD_ATTACHMENTS_MAX,
    ),
  })
  @IsArray({
    message: getValidationMessage(
      DtoPrefix.ATTACHMENTS,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  @IsOptional()
  @Type(() => AttachmentReferenceDto)
  attachments?: AttachmentReferenceDto[] | undefined;

  @ValidateNested()
  @IsObject({
    message: getValidationMessage(
      DtoPrefix.CONTENT,
      ValidationType.WRONG_DATA_TYPE,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.CONTENT, ValidationType.NOT_EMPTY),
  })
  @Type(() => RecordContentDto)
  content!: RecordContentDto;
}
