import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export class ListUsersByClinicRequestDto
  implements users.ListUsersByClinicRequest
{
  @IsUUID('4', {
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @IsNotEmpty({
    message: getValidationMessage(
      DtoPrefix.CLINIC_ID,
      ValidationType.NOT_EMPTY,
    ),
  })
  clinicId!: string;

  @IsOptional()
  @IsIn(
    [
      users.UserRole.PET_OWNER,
      users.UserRole.STAFF,
      users.UserRole.VETERINARIAN,
    ],
    {
      message: getValidationMessage(
        DtoPrefix.USER_ROLE,
        ValidationType.WRONG_DATA_FORMAT,
      ),
    },
  )
  role?: users.UserRole | undefined;

  @Type(() => Number)
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
  @Min(1, {
    message: getValidationMessage(DtoPrefix.PAGE, ValidationType.MIN, 1),
  })
  page!: number;

  @Type(() => Number)
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
  @IsIn([8, 16, 32, 64, 128], {
    message: getValidationMessage(
      DtoPrefix.PAGE_SIZE,
      ValidationType.NOT_VALID,
    ),
  })
  pageSize!: number;
}
