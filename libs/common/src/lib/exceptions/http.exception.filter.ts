import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { DtoPrefix } from '../enums/messages/ValidationMessages.enum';
import { ResponseMessages } from '../enums/messages/ResponseMessages.enum';
import { BaseResponse } from '../base/base.response';
import { RpcException } from '@nestjs/microservices';
import { getStatusFromMessage } from '../enums/mapper/get-status-from-message';

@Catch(HttpException, RpcException)
export class HttpsExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException | RpcException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = exception.message;

      const prefix: DtoPrefix[] = Object.values(DtoPrefix);
      const validationMessage = prefix.find((p) => message?.startsWith(p));

      if (validationMessage) {
        return response
          .status(status)
          .json(new BaseResponse(null, message, false));
      }

      const isCustomMessage = Object.values(ResponseMessages).includes(
        message as ResponseMessages,
      );
      if (isCustomMessage) {
        return response
          .status(status)
          .json(new BaseResponse(null, message, false));
      }

      return response
        .status(status)
        .json(new BaseResponse(null, this.mapStatusToMessage(status), false));
    }

    const rpcError =
      exception instanceof RpcException ? exception.getError() : exception;

    const grpcMessage =
      typeof rpcError === 'object' && rpcError !== null && 'message' in rpcError
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (rpcError as any).message
        : typeof rpcError === 'string'
          ? rpcError
          : null;

    const isKnownCode =
      grpcMessage &&
      Object.values(ResponseMessages).includes(grpcMessage as ResponseMessages);

    const status = isKnownCode
      ? getStatusFromMessage(grpcMessage)
      : HttpStatus.INTERNAL_SERVER_ERROR;

    return response
      .status(status)
      .json(
        new BaseResponse(
          null,
          isKnownCode ? grpcMessage : ResponseMessages.INTERNAL_SERVER_ERROR,
          false,
        ),
      );
  }

  private mapStatusToMessage(status: number): string {
    switch (status) {
      case 400:
        return ResponseMessages.BAD_REQUEST;
      case 401:
        return ResponseMessages.UNAUTH;
      case 403:
        return ResponseMessages.FORBIDDEN;
      case 404:
        return ResponseMessages.NOT_FOUND;
      case 405:
        return ResponseMessages.METHOD_NOT_ALLOWED;
      case 409:
        return ResponseMessages.CONFLICT;
      case 422:
        return ResponseMessages.UNPROCESSABLE_ENTITY;
      case 429:
        return ResponseMessages.TOO_MANY_REQUESTS;
      case 502:
        return ResponseMessages.BAD_GATEWAY;
      case 503:
        return ResponseMessages.SERVICE_UNAVAILABLE;
      default:
        return ResponseMessages.INTERNAL_SERVER_ERROR;
    }
  }
}
