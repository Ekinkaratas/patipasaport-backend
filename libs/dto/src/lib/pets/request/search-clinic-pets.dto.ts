import {
  DtoPrefix,
  getValidationMessage,
  PET_SPECIES,
  ResponseMessages,
  SORT_ORDERS,
  SortOrder,
  ValidationType,
} from '@libs/common';
import { pets } from '@libs/proto';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  Min,
  ValidateBy,
  ValidationArguments,
} from 'class-validator';
import { ChipNumber, PetName } from '../../shared/pet-fields.decorator';

export class SearchClinicPetsRequestDto
  implements pets.SearchClinicPetsRequest
{
  @ValidateBy(
    {
      name: 'singleSearchQuery',
      validator: {
        validate: (_value: unknown, args?: ValidationArguments) =>
          (args?.object as SearchClinicPetsRequestDto).chipNumber === undefined,
      },
    },
    { message: ResponseMessages.BAD_REQUEST },
  )
  @PetName('emptyAsAbsent')
  name?: string | undefined;

  @ChipNumber('emptyAsAbsent')
  chipNumber?: string | undefined;

  @IsIn(PET_SPECIES, {
    message: getValidationMessage(DtoPrefix.SPECIES, ValidationType.NOT_VALID),
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  species?: string | undefined;

  @Type(() => Number)
  @Min(1, {
    message: getValidationMessage(DtoPrefix.PAGE, ValidationType.MIN, 1),
  })
  @IsNumber(
    {
      allowNaN: false,
      allowInfinity: false,
      maxDecimalPlaces: 0,
    },
    {
      message: getValidationMessage(
        DtoPrefix.PAGE,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  page!: number;

  @Type(() => Number)
  @IsIn([8, 16, 32, 64, 128], {
    message: getValidationMessage(
      DtoPrefix.PAGE_SIZE,
      ValidationType.NOT_VALID,
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
        DtoPrefix.PAGE_SIZE,
        ValidationType.MUST_BE_NUMBER,
      ),
    },
  )
  pageSize!: number;

  @IsIn(SORT_ORDERS, {
    message: getValidationMessage(
      DtoPrefix.ORDER_FILTER,
      ValidationType.NOT_VALID,
    ),
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  orderFilter?: SortOrder | undefined;
}
