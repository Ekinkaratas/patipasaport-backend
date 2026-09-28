import { DtoPrefix, getValidationMessage, ValidationType } from '@libs/common';
import { users } from '@libs/proto';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class GetUserDisplayNamesRequesDto
  implements users.GetUserDisplayNamesRequest
{
  @Transform(({ value }) =>
    Array.isArray(value) ? Array.from(new Set(value)) : value,
  )
  @IsUUID('4', {
    each: true,
    message: getValidationMessage(
      DtoPrefix.USER_IDS,
      ValidationType.WRONG_DATA_FORMAT,
    ),
  })
  @ArrayMaxSize(20, {
    message: getValidationMessage(DtoPrefix.USER_IDS, ValidationType.MAX, 20),
  })
  @ArrayMinSize(1, {
    message: getValidationMessage(DtoPrefix.USER_IDS, ValidationType.MIN, 1),
  })
  @IsArray({
    message: getValidationMessage(
      DtoPrefix.USER_IDS,
      ValidationType.MUST_BE_ARRAY,
    ),
  })
  userIds!: string[];
}
