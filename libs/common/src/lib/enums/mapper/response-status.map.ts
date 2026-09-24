import { HttpStatus } from '@nestjs/common';
import { ResponseMessages } from '../messages';

export const ResponseStatusMap: Record<ResponseMessages, HttpStatus> = {
  [ResponseMessages.SUCCESS]: HttpStatus.OK,
  [ResponseMessages.CREATED]: HttpStatus.CREATED,

  [ResponseMessages.BAD_REQUEST]: HttpStatus.BAD_REQUEST,
  [ResponseMessages.UNAUTH]: HttpStatus.UNAUTHORIZED,
  [ResponseMessages.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ResponseMessages.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ResponseMessages.METHOD_NOT_ALLOWED]: HttpStatus.METHOD_NOT_ALLOWED,
  [ResponseMessages.CONFLICT]: HttpStatus.CONFLICT,
  [ResponseMessages.UNPROCESSABLE_ENTITY]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ResponseMessages.TOO_MANY_REQUESTS]: HttpStatus.TOO_MANY_REQUESTS,

  [ResponseMessages.INTERNAL_SERVER_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ResponseMessages.BAD_GATEWAY]: HttpStatus.BAD_GATEWAY,
  [ResponseMessages.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,

  [ResponseMessages.PASSWORD_OR_EMAIL_WRONG]: HttpStatus.UNAUTHORIZED,
  [ResponseMessages.USER_TYPE_NOT_VALID_FOR_REGISTER]: HttpStatus.BAD_REQUEST,
  [ResponseMessages.EMAIL_ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [ResponseMessages.PHONE_ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [ResponseMessages.TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ResponseMessages.INVALID_TOKEN]: HttpStatus.UNAUTHORIZED,
  [ResponseMessages.VALIDATION_ERROR]: HttpStatus.BAD_REQUEST,
  [ResponseMessages.INVALID_CLIENT_TYPE]: HttpStatus.BAD_REQUEST,
};
