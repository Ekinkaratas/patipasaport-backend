import {
  DtoPrefix,
  getValidationMessage,
  ResponseMessages,
  ValidationType,
} from '@libs/common';
import { pets } from '@libs/proto';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  ValidateBy,
  ValidationArguments,
} from 'class-validator';
import {
  BirthDate,
  ChipNumber,
  PetBreed,
  PetName,
} from '../../shared/pet-fields.decorator';

const UPDATABLE_FIELDS = [
  'name',
  'breed',
  'birthDate',
  'isBirthDateEstimated',
  'isNeutered',
  'chipNumber',
] as const;

export class UpdatePetRequestDto implements pets.UpdatePetRequest {
  @ValidateBy(
    {
      name: 'hasAtLeastOneUpdatableField',
      validator: {
        validate: (_value: unknown, args?: ValidationArguments) => {
          const dto = args?.object as UpdatePetRequestDto;
          return UPDATABLE_FIELDS.some(
            (field) => dto[field] !== undefined && dto[field] !== null,
          );
        },
      },
    },
    { message: ResponseMessages.BAD_REQUEST },
  )
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.PET_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.PET_ID, ValidationType.NOT_EMPTY),
  })
  id!: string;

  @PetName('optional')
  name?: string | undefined;

  @PetBreed('optional')
  breed?: string | undefined;

  @BirthDate('optional')
  birthDate?: string | undefined;

  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.IS_BIRTH_DATE_ESTIMATED,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsOptional()
  isBirthDateEstimated?: boolean | undefined;

  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.IS_NEUTERED,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsOptional()
  isNeutered?: boolean | undefined;

  @ChipNumber('optional')
  chipNumber?: string | undefined;
}
