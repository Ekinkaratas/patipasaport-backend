import { status } from '@grpc/grpc-js';
import { ResponseMessages } from '../messages';

export const GrpcStatusMap: Record<ResponseMessages, status> = {
  [ResponseMessages.SUCCESS]: status.OK,
  [ResponseMessages.CREATED]: status.OK,

  [ResponseMessages.BAD_REQUEST]: status.INVALID_ARGUMENT,
  [ResponseMessages.UNPROCESSABLE_ENTITY]: status.INVALID_ARGUMENT,
  [ResponseMessages.VALIDATION_ERROR]: status.INVALID_ARGUMENT,
  [ResponseMessages.INVALID_CLIENT_TYPE]: status.INVALID_ARGUMENT,

  [ResponseMessages.UNAUTH]: status.UNAUTHENTICATED,
  [ResponseMessages.TOKEN_EXPIRED]: status.UNAUTHENTICATED,
  [ResponseMessages.INVALID_TOKEN]: status.UNAUTHENTICATED,
  [ResponseMessages.PASSWORD_OR_EMAIL_WRONG]: status.UNAUTHENTICATED,

  [ResponseMessages.FORBIDDEN]: status.PERMISSION_DENIED,
  [ResponseMessages.USER_TYPE_NOT_VALID_FOR_REGISTER]: status.PERMISSION_DENIED,

  [ResponseMessages.NOT_FOUND]: status.NOT_FOUND,

  [ResponseMessages.CONFLICT]: status.ALREADY_EXISTS,
  [ResponseMessages.EMAIL_ALREADY_EXISTS]: status.ALREADY_EXISTS,
  [ResponseMessages.PHONE_ALREADY_EXISTS]: status.ALREADY_EXISTS,

  [ResponseMessages.METHOD_NOT_ALLOWED]: status.UNIMPLEMENTED,
  [ResponseMessages.TOO_MANY_REQUESTS]: status.RESOURCE_EXHAUSTED,

  [ResponseMessages.BAD_GATEWAY]: status.UNAVAILABLE,
  [ResponseMessages.SERVICE_UNAVAILABLE]: status.UNAVAILABLE,
  [ResponseMessages.INTERNAL_SERVER_ERROR]: status.INTERNAL,
};
