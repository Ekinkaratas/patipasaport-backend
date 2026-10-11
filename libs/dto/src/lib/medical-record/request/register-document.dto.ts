import {
  DtoPrefix,
  getValidationMessage,
  PET_RESULT_FILE_EXTENSIONS,
  PET_RESULT_MAX_SIZE_BYTES,
  PET_RESULT_MIME_TYPES,
  PetResultMimeType,
  ValidationType,
} from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidationArguments,
} from 'class-validator';
import {
  NOTE_MAX_LENGTH,
  ORIGINAL_NAME_MAX_LENGTH,
  SHA256_PATTERN,
  STORAGE_PATH_PATTERN,
} from '../../clinics/request/upload-pet-result.dto';

const isPetResultMimeType = (value: unknown): value is PetResultMimeType =>
  PET_RESULT_MIME_TYPES.includes(value as PetResultMimeType);

const isControlCharacter = (code: number): boolean =>
  code < 0x20 || code === 0x7f;

const isSafeFileName = (value: unknown): boolean =>
  typeof value === 'string' &&
  [...value].every(
    (char) =>
      char !== '/' && char !== '\\' && !isControlCharacter(char.charCodeAt(0)),
  );

const isPlainNote = (value: unknown): boolean =>
  typeof value === 'string' &&
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code === 0x0a || code === 0x0d || !isControlCharacter(code);
  });

const extensionMatchesMimeType = (
  value: unknown,
  args?: ValidationArguments,
): boolean => {
  const mimeType = (args?.object as { mimeType?: unknown } | undefined)
    ?.mimeType;
  if (!isPetResultMimeType(mimeType) || typeof value !== 'string') {
    return true;
  }
  const extension = value.slice(value.lastIndexOf('.') + 1);
  return (PET_RESULT_FILE_EXTENSIONS[mimeType] as readonly string[]).includes(
    extension,
  );
};

export class RegisterDocumentRequestDto
  implements medicalRecord.RegisterDocumentRequest
{
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PET_ID, ValidationType.NOT_EMPTY),
  })
  petId!: string;

  @ValidateBy(
    {
      name: 'extensionMatchesMimeType',
      validator: { validate: extensionMatchesMimeType },
    },
    {
      message: getValidationMessage(
        DtoPrefix.STORAGE_PATH,
        ValidationType.NOT_VALID,
      ),
    },
  )
  @Matches(STORAGE_PATH_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.STORAGE_PATH,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.STORAGE_PATH,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.STORAGE_PATH,
      ValidationType.NOT_EMPTY,
    ),
  })
  storagePath!: string;

  @ValidateBy(
    {
      name: 'isSafeFileName',
      validator: { validate: isSafeFileName },
    },
    {
      message: getValidationMessage(
        DtoPrefix.ORIGINAL_NAME,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    },
  )
  @MaxLength(ORIGINAL_NAME_MAX_LENGTH, {
    message: getValidationMessage(
      DtoPrefix.ORIGINAL_NAME,
      ValidationType.MAX_LENGTH,
      ORIGINAL_NAME_MAX_LENGTH,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.ORIGINAL_NAME,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.ORIGINAL_NAME,
      ValidationType.NOT_EMPTY,
    ),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  originalName!: string;

  @IsIn(PET_RESULT_MIME_TYPES, {
    message: getValidationMessage(
      DtoPrefix.MIME_TYPE,
      ValidationType.NOT_VALID,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.MIME_TYPE,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.MIME_TYPE,
      ValidationType.NOT_EMPTY,
    ),
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  mimeType!: string;

  @Type(() => Number)
  @Max(PET_RESULT_MAX_SIZE_BYTES, {
    message: getValidationMessage(
      DtoPrefix.SIZE_BYTES,
      ValidationType.MAX,
      PET_RESULT_MAX_SIZE_BYTES,
    ),
  })
  @Min(1, {
    message: getValidationMessage(DtoPrefix.SIZE_BYTES, ValidationType.MIN, 1),
  })
  @IsNumber(
    {
      allowNaN: false,
      allowInfinity: false,
      maxDecimalPlaces: 0,
    },
    {
      message: getValidationMessage(
        DtoPrefix.SIZE_BYTES,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  sizeBytes!: number;

  @ValidateBy(
    {
      name: 'isPlainNote',
      validator: { validate: isPlainNote },
    },
    {
      message: getValidationMessage(
        DtoPrefix.NOTE,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    },
  )
  @MaxLength(NOTE_MAX_LENGTH, {
    message: getValidationMessage(
      DtoPrefix.NOTE,
      ValidationType.MAX_LENGTH,
      NOTE_MAX_LENGTH,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.NOTE,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsOptional()
  @Transform(({ value }) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? undefined : trimmed;
  })
  note!: string;

  @Matches(SHA256_PATTERN, {
    message: getValidationMessage(
      DtoPrefix.SHA256,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsString({
    message: getValidationMessage(
      DtoPrefix.SHA256,
      ValidationType.MUST_BE_STRING,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.SHA256, ValidationType.NOT_EMPTY),
  })
  sha256!: string;
}
