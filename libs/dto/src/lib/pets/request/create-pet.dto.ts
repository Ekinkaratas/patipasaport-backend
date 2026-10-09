import {
  DtoPrefix,
  getValidationMessage,
  PET_SPECIES,
  ValidationType,
} from '@libs/common';
import { pets } from '@libs/proto';
import {
  IsBoolean,
  IsIn,
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

export class CreatePetRequestDto implements pets.CreatePetRequest {
  @PetName('required')
  name!: string;

  @IsIn(PET_SPECIES, {
    message: getValidationMessage(DtoPrefix.SPECIES, ValidationType.NOT_VALID),
  })
  @IsNotEmpty({
    message: getValidationMessage(DtoPrefix.SPECIES, ValidationType.NOT_EMPTY),
  })
  species!: string;

  @PetBreed('required')
  breed!: string;

  @IsIn([pets.PetSex.MALE, pets.PetSex.FEMALE], {
    message: getValidationMessage(
      DtoPrefix.SEX,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  sex!: pets.PetSex;

  @BirthDate('emptyAsAbsent')
  birthDate!: string;

  @ValidateBy(
    {
      name: 'estimatedNeedsBirthDate',
      validator: {
        validate: (value: unknown, args?: ValidationArguments) =>
          value !== true ||
          (args?.object as CreatePetRequestDto).birthDate !== undefined,
      },
    },
    {
      message: getValidationMessage(
        DtoPrefix.BIRTH_DATE,
        ValidationType.NOT_EMPTY,
      ),
    },
  )
  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.IS_BIRTH_DATE_ESTIMATED,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsOptional()
  isBirthDateEstimated!: boolean;

  @IsBoolean({
    message: getValidationMessage(
      DtoPrefix.IS_NEUTERED,
      ValidationType.MUST_BE_BOOLEAN,
    ),
  })
  @IsOptional()
  isNeutered!: boolean;

  @ChipNumber('emptyAsAbsent')
  chipNumber!: string;

  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.OWNER_USER_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.OWNER_USER_ID,
      ValidationType.NOT_EMPTY,
    ),
  })
  ownerUserId!: string;
}
