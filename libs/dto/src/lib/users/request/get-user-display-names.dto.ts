import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

export class GetUserDisplayNamesRequesDto
  implements users.GetUserDisplayNamesRequest
{
  @Transform(({ value }) =>
    Array.isArray(value) ? Array.from(new Set(value)) : value,
  )
  @IsArray({
    message: getValidationMessage(
      DtoPrefix.USER_IDS,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  @ArrayMinSize(1, {
    message: getValidationMessage(DtoPrefix.USER_IDS, ValidationType.MIN, 1),
  })
  @ArrayMaxSize(50, {
    message: getValidationMessage(DtoPrefix.USER_IDS, ValidationType.MAX, 20),
  })
  @IsUUID('4', {
    each: true,
    message: getValidationMessage(
      DtoPrefix.USER_IDS,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  userIds!: string[];
}
