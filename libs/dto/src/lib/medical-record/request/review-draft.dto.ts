import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
} from 'class-validator';
import {
  MedicalText,
  MedicalUuid,
} from '../../shared/medical-fields.decorator';
import { RecordContentDto } from './record-content.dto';

export const REVIEW_NOTE_MAX_LENGTH = 500;

export class ReviewDraftRequestDto implements medicalRecord.ReviewDraftRequest {
  @MedicalUuid(DtoPrefix.DRAFT_REVIEW_ID, 'required')
  id!: string;

  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.APPROVED,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.APPROVED, ValidationType.NOT_EMPTY),
  })
  approved!: boolean;

  @MedicalText(DtoPrefix.REVIEW_NOTE, {
    presence: 'required',
    maxLength: REVIEW_NOTE_MAX_LENGTH,
  })
  @ValidateIf(
    (object: ReviewDraftRequestDto, value: unknown) =>
      object.approved === false || (value !== undefined && value !== ''),
  )
  reviewNote!: string;

  @ValidateNested()
  @IsObject({
    message: getValidationMessage(
      DtoPrefix.EDITED_CONTENT,
      ValidationType.WRONG_DATA_TYPE,
    ),
  })
  @ValidateBy(
    {
      name: 'editedContentOnlyWhenApproved',
      validator: {
        validate: (_value: unknown, args?: ValidationArguments) =>
          (args?.object as ReviewDraftRequestDto | undefined)?.approved !==
          false,
      },
    },
    {
      message: getValidationMessage(
        DtoPrefix.EDITED_CONTENT,
        ValidationType.NOT_VALID,
      ),
    },
  )
  @ValidateIf((_object: ReviewDraftRequestDto, value: unknown) => value != null)
  @Type(() => RecordContentDto)
  editedContent!: RecordContentDto | undefined;
}
