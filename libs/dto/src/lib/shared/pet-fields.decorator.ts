import { applyDecorators } from '@nestjs/common';
import {
  DtoPrefix,
  getValidationMessage,
  normalizeWhitespace,
  PET_BREED_CODES,
  PET_BREEDS,
  PET_SPECIES,
  PetBreedCode,
  PetSpecies,
  ValidationType,
} from '@libs/common';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidationArguments,
} from 'class-validator';

export type PetFieldPresence = 'required' | 'optional' | 'emptyAsAbsent';

export const PET_TEXT_PATTERN =
  /^[a-zA-ZçğıöşüâîûÇĞİÖŞÜÂÎÛ]+(?: [a-zA-ZçğıöşüâîûÇĞİÖŞÜÂÎÛ]+)*$/;
export const PET_NAME_MAX_LENGTH = 32;
export const CHIP_NUMBER_PATTERN = /^\d{15}$/;
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const BUSINESS_TIME_ZONE = 'Europe/Istanbul';

const removeWhitespace = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

const trim = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const todayInBusinessTimeZone = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

function presence(
  mode: PetFieldPresence,
  normalize: (value: unknown) => unknown,
): PropertyDecorator[] {
  if (mode === 'emptyAsAbsent') {
    return [
      Transform(({ value }) => {
        const normalized = normalize(value);
        return normalized === '' ? undefined : normalized;
      }),
      IsOptional(),
    ];
  }
  const transform = Transform(({ value }) => normalize(value));
  return mode === 'optional' ? [transform, IsOptional()] : [transform];
}

function petText(
  prefix: DtoPrefix,
  maxLength: number,
  mode: PetFieldPresence,
): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, normalizeWhitespace),
    IsNotEmpty({
      message: getValidationMessage(prefix, ValidationType.NOT_EMPTY),
    }),
    IsString({
      message: getValidationMessage(prefix, ValidationType.MUST_BE_STRING),
    }),
    MaxLength(maxLength, {
      message: getValidationMessage(
        prefix,
        ValidationType.MAX_LENGTH,
        maxLength,
      ),
    }),
    Matches(PET_TEXT_PATTERN, {
      message: getValidationMessage(prefix, ValidationType.WRONG_DATA_FORMAT),
    }),
  );
}

export function PetName(mode: PetFieldPresence): PropertyDecorator {
  return petText(DtoPrefix.PET_NAME, PET_NAME_MAX_LENGTH, mode);
}

const isPetSpecies = (value: unknown): value is PetSpecies =>
  PET_SPECIES.includes(value as PetSpecies);

function breedMatchesSpecies(breed: unknown, species: unknown): boolean {
  if (species === undefined) {
    return PET_BREED_CODES.includes(breed as PetBreedCode);
  }
  if (!isPetSpecies(species)) return true;
  return (PET_BREEDS[species] as readonly string[]).includes(breed as string);
}

export function PetBreed(mode: PetFieldPresence): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, trim),
    IsNotEmpty({
      message: getValidationMessage(DtoPrefix.BREED, ValidationType.NOT_EMPTY),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.BREED,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    ValidateBy(
      {
        name: 'breedMatchesSpecies',
        validator: {
          validate: (value: unknown, args?: ValidationArguments) =>
            breedMatchesSpecies(
              value,
              (args?.object as { species?: unknown } | undefined)?.species,
            ),
        },
      },
      {
        message: getValidationMessage(
          DtoPrefix.BREED,
          ValidationType.NOT_VALID,
        ),
      },
    ),
  );
}

export function ChipNumber(mode: PetFieldPresence): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, removeWhitespace),
    IsNotEmpty({
      message: getValidationMessage(
        DtoPrefix.CHIP_NUMBER,
        ValidationType.NOT_EMPTY,
      ),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.CHIP_NUMBER,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    Matches(CHIP_NUMBER_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.CHIP_NUMBER,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    }),
  );
}

export function BirthDate(mode: PetFieldPresence): PropertyDecorator {
  return applyDecorators(
    ...presence(mode, trim),
    IsNotEmpty({
      message: getValidationMessage(
        DtoPrefix.BIRTH_DATE,
        ValidationType.NOT_EMPTY,
      ),
    }),
    IsString({
      message: getValidationMessage(
        DtoPrefix.BIRTH_DATE,
        ValidationType.MUST_BE_STRING,
      ),
    }),
    Matches(DATE_ONLY_PATTERN, {
      message: getValidationMessage(
        DtoPrefix.BIRTH_DATE,
        ValidationType.MUST_BE_DATE,
      ),
    }),
    IsDateString(
      { strict: true },
      {
        message: getValidationMessage(
          DtoPrefix.BIRTH_DATE,
          ValidationType.MUST_BE_DATE,
        ),
      },
    ),
    ValidateBy(
      {
        name: 'isNotFutureDate',
        validator: {
          validate: (value: unknown) =>
            typeof value === 'string' && value <= todayInBusinessTimeZone(),
        },
      },
      {
        message: getValidationMessage(
          DtoPrefix.BIRTH_DATE,
          ValidationType.CANNOT_BE_FUTURE,
        ),
      },
    ),
  );
}
