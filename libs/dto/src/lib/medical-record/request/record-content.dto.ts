import { applyDecorators } from '@nestjs/common';
import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
} from 'class-validator';
import {
  DateAfter,
  MedicalDate,
  MedicalText,
  OptionalNumericEnum,
} from '../../shared/medical-fields.decorator';

export const MEDICAL_RECORD_TYPES = [
  medicalRecord.RecordType.EXAMINATION,
  medicalRecord.RecordType.VACCINATION,
  medicalRecord.RecordType.PRESCRIPTION,
  medicalRecord.RecordType.LAB_RESULT,
  medicalRecord.RecordType.SURGERY,
] as const;

export const LAB_RESULT_FLAGS = [
  medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
  medicalRecord.LabResultFlag.NORMAL,
  medicalRecord.LabResultFlag.LOW,
  medicalRecord.LabResultFlag.HIGH,
] as const;

export const RECORD_TITLE_MIN_LENGTH = 2;
export const RECORD_TITLE_MAX_LENGTH = 128;
export const RECORD_NOTES_MAX_LENGTH = 2000;
export const MEDICAL_NAME_MAX_LENGTH = 128;
export const MEDICAL_SHORT_TEXT_MAX_LENGTH = 64;
export const LAB_UNIT_MAX_LENGTH = 32;
export const PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH = 1000;
export const DURATION_DAYS_MIN = 1;
export const DURATION_DAYS_MAX = 365;
export const LAB_RESULT_ITEMS_MIN = 1;
export const LAB_RESULT_ITEMS_MAX = 50;

const recordTypeOf = (args?: ValidationArguments): unknown =>
  (args?.object as { type?: unknown } | undefined)?.type;

function DetailsFor(
  recordType: medicalRecord.RecordType,
  prefix: DtoPrefix,
  detailsClass: () => new () => object,
): PropertyDecorator {
  return applyDecorators(
    Type(detailsClass),
    ValidateIf(
      (object: { type?: unknown }, value: unknown) =>
        value != null || object.type === recordType,
    ),
    ValidateBy(
      {
        name: 'detailsRequiredForType',
        validator: {
          validate: (value: unknown, args?: ValidationArguments) =>
            value != null || recordTypeOf(args) !== recordType,
        },
      },
      {
        message: getValidationMessage(prefix, ValidationType.NOT_EMPTY),
      },
    ),
    ValidateBy(
      {
        name: 'detailsMatchType',
        validator: {
          validate: (_value: unknown, args?: ValidationArguments) =>
            recordTypeOf(args) === recordType,
        },
      },
      {
        message: getValidationMessage(prefix, ValidationType.NOT_VALID),
      },
    ),
    IsObject({
      message: getValidationMessage(prefix, ValidationType.WRONG_DATA_TYPE),
    }),
    ValidateNested(),
  );
}

export class VaccinationDetailsDto implements medicalRecord.VaccinationDetails {
  @MedicalText(DtoPrefix.VACCINE_NAME, {
    presence: 'required',
    maxLength: MEDICAL_NAME_MAX_LENGTH,
  })
  vaccineName!: string;

  @MedicalText(DtoPrefix.BATCH_NUMBER, {
    presence: 'optional',
    maxLength: MEDICAL_SHORT_TEXT_MAX_LENGTH,
  })
  batchNumber!: string;

  @MedicalDate(DtoPrefix.ADMINISTERED_AT, {
    presence: 'required',
    notFuture: true,
  })
  administeredAt!: string;

  @DateAfter(DtoPrefix.NEXT_DUE_AT, 'administeredAt', false)
  @MedicalDate(DtoPrefix.NEXT_DUE_AT, { presence: 'optional' })
  nextDueAt!: string;
}

export class PrescriptionDetailsDto
  implements medicalRecord.PrescriptionDetails
{
  @MedicalText(DtoPrefix.MEDICATION_NAME, {
    presence: 'required',
    maxLength: MEDICAL_NAME_MAX_LENGTH,
  })
  medicationName!: string;

  @MedicalText(DtoPrefix.DOSAGE, {
    presence: 'required',
    maxLength: MEDICAL_SHORT_TEXT_MAX_LENGTH,
  })
  dosage!: string;

  @MedicalText(DtoPrefix.FREQUENCY, {
    presence: 'required',
    maxLength: MEDICAL_SHORT_TEXT_MAX_LENGTH,
  })
  frequency!: string;

  @Max(DURATION_DAYS_MAX, {
    message: getValidationMessage(
      DtoPrefix.DURATION_DAYS,
      ValidationType.MAX,
      DURATION_DAYS_MAX,
    ),
  })
  @Min(DURATION_DAYS_MIN, {
    message: getValidationMessage(
      DtoPrefix.DURATION_DAYS,
      ValidationType.MIN,
      DURATION_DAYS_MIN,
    ),
  })
  @IsNumber(
    {
      allowNaN: false,
      allowInfinity: false,
      maxDecimalPlaces: 0,
    },
    {
      message: getValidationMessage(
        DtoPrefix.DURATION_DAYS,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  @Type(() => Number)
  durationDays!: number;

  @MedicalText(DtoPrefix.INSTRUCTIONS, {
    presence: 'optional',
    maxLength: PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH,
    multiline: true,
  })
  instructions!: string;

  @MedicalDate(DtoPrefix.PRESCRIBED_AT, {
    presence: 'required',
    notFuture: true,
  })
  prescribedAt!: string;
}

export class LabResultItemDto implements medicalRecord.LabResultItem {
  @MedicalText(DtoPrefix.TEST_NAME, {
    presence: 'required',
    maxLength: MEDICAL_NAME_MAX_LENGTH,
  })
  testName!: string;

  @MedicalText(DtoPrefix.LAB_VALUE, {
    presence: 'required',
    maxLength: MEDICAL_SHORT_TEXT_MAX_LENGTH,
  })
  value!: string;

  @MedicalText(DtoPrefix.LAB_UNIT, {
    presence: 'optional',
    maxLength: LAB_UNIT_MAX_LENGTH,
  })
  unit!: string;

  @MedicalText(DtoPrefix.REFERENCE_RANGE, {
    presence: 'optional',
    maxLength: MEDICAL_SHORT_TEXT_MAX_LENGTH,
  })
  referenceRange!: string;

  @OptionalNumericEnum(DtoPrefix.LAB_RESULT_FLAG, LAB_RESULT_FLAGS)
  flag!: medicalRecord.LabResultFlag;
}

export class LabResultDetailsDto implements medicalRecord.LabResultDetails {
  @ValidateNested()
  @ArrayMaxSize(LAB_RESULT_ITEMS_MAX, {
    message: getValidationMessage(
      DtoPrefix.LAB_RESULT_ITEMS,
      ValidationType.MAX,
      LAB_RESULT_ITEMS_MAX,
    ),
  })
  @ArrayMinSize(LAB_RESULT_ITEMS_MIN, {
    message: getValidationMessage(
      DtoPrefix.LAB_RESULT_ITEMS,
      ValidationType.MIN,
      LAB_RESULT_ITEMS_MIN,
    ),
  })
  @IsArray({
    message: getValidationMessage(
      DtoPrefix.LAB_RESULT_ITEMS,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  @Type(() => LabResultItemDto)
  items!: LabResultItemDto[];

  @MedicalDate(DtoPrefix.SAMPLED_AT, {
    presence: 'required',
    notFuture: true,
  })
  sampledAt!: string;
}

export class RecordContentDto implements medicalRecord.RecordContent {
  @IsIn(MEDICAL_RECORD_TYPES, {
    message: getValidationMessage(
      DtoPrefix.RECORD_TYPE,
      ValidationType.NOT_VALID,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.RECORD_TYPE,
      ValidationType.NOT_EMPTY,
    ),
  })
  type!: medicalRecord.RecordType;

  @MedicalText(DtoPrefix.TITLE, {
    presence: 'required',
    minLength: RECORD_TITLE_MIN_LENGTH,
    maxLength: RECORD_TITLE_MAX_LENGTH,
  })
  title!: string;

  @MedicalText(DtoPrefix.NOTES, {
    presence: 'optional',
    maxLength: RECORD_NOTES_MAX_LENGTH,
    multiline: true,
  })
  notes!: string;

  @MedicalDate(DtoPrefix.RECORDED_AT, {
    presence: 'required',
    notFuture: true,
  })
  recordedAt!: string;

  @DetailsFor(
    medicalRecord.RecordType.VACCINATION,
    DtoPrefix.VACCINATION,
    () => VaccinationDetailsDto,
  )
  vaccination?: VaccinationDetailsDto | undefined;

  @DetailsFor(
    medicalRecord.RecordType.PRESCRIPTION,
    DtoPrefix.PRESCRIPTION,
    () => PrescriptionDetailsDto,
  )
  prescription?: PrescriptionDetailsDto | undefined;

  @DetailsFor(
    medicalRecord.RecordType.LAB_RESULT,
    DtoPrefix.LAB_RESULT,
    () => LabResultDetailsDto,
  )
  labResult?: LabResultDetailsDto | undefined;
}
