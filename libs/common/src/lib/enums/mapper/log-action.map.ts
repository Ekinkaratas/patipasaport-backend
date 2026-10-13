import { LogAction } from '../logging';
import { ResponseMessages } from '../messages';

export const LogActionMap: Record<ResponseMessages, LogAction> = {
  [ResponseMessages.SUCCESS]: LogAction.REQUEST_SUCCESS,
  [ResponseMessages.CREATED]: LogAction.REQUEST_SUCCESS,

  [ResponseMessages.BAD_REQUEST]: LogAction.VALIDATION_FAILED,
  [ResponseMessages.UNPROCESSABLE_ENTITY]: LogAction.VALIDATION_FAILED,
  [ResponseMessages.VALIDATION_ERROR]: LogAction.VALIDATION_FAILED,
  [ResponseMessages.INVALID_CLIENT_TYPE]: LogAction.VALIDATION_FAILED,
  [ResponseMessages.REQUEST_BODY_TOO_DEEP]: LogAction.VALIDATION_FAILED,

  [ResponseMessages.UNAUTH]: LogAction.UNAUTHORIZED,
  [ResponseMessages.TOKEN_EXPIRED]: LogAction.UNAUTHORIZED,
  [ResponseMessages.INVALID_TOKEN]: LogAction.UNAUTHORIZED,
  [ResponseMessages.PASSWORD_OR_EMAIL_WRONG]: LogAction.UNAUTHORIZED,

  [ResponseMessages.FORBIDDEN]: LogAction.FORBIDDEN,
  [ResponseMessages.USER_TYPE_NOT_VALID_FOR_REGISTER]: LogAction.FORBIDDEN,
  [ResponseMessages.ACCOUNT_DISABLED]: LogAction.FORBIDDEN,
  [ResponseMessages.PERMISSION_DENIED]: LogAction.FORBIDDEN,

  [ResponseMessages.NOT_FOUND]: LogAction.NOT_FOUND,

  [ResponseMessages.CONFLICT]: LogAction.CONFLICT,
  [ResponseMessages.EMAIL_ALREADY_EXISTS]: LogAction.CONFLICT,
  [ResponseMessages.PHONE_ALREADY_EXISTS]: LogAction.CONFLICT,
  [ResponseMessages.TAX_NUMBER_ALREADY_EXISTS]: LogAction.CONFLICT,

  [ResponseMessages.METHOD_NOT_ALLOWED]: LogAction.REQUEST_FAILED,
  [ResponseMessages.TOO_MANY_REQUESTS]: LogAction.RATE_LIMITED,

  [ResponseMessages.BAD_GATEWAY]: LogAction.DEPENDENCY_FAILED,
  [ResponseMessages.SERVICE_UNAVAILABLE]: LogAction.DEPENDENCY_FAILED,
  [ResponseMessages.INTERNAL_SERVER_ERROR]: LogAction.INTERNAL_ERROR,
};
