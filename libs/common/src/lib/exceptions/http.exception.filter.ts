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
import { getCorrelationId } from '../storage';

@Catch(HttpException, RpcException)
export class HttpsExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException | RpcException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const correlationId = getCorrelationId();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const messages = this.extractMessages(exception);

      const prefixes: DtoPrefix[] = Object.values(DtoPrefix);
      const validationMessage = messages.find((m) =>
        prefixes.some((p) => m.startsWith(p)),
      );

      if (validationMessage) {
        return response
          .status(status)
          .json(
            new BaseResponse(null, validationMessage, false, correlationId),
          );
      }

      const customMessage = messages.find((m) =>
        Object.values(ResponseMessages).includes(m as ResponseMessages),
      );
      if (customMessage) {
        return response
          .status(status)
          .json(new BaseResponse(null, customMessage, false, correlationId));
      }

      return response
        .status(status)
        .json(
          new BaseResponse(
            null,
            this.mapStatusToMessage(status),
            false,
            correlationId,
          ),
        );
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
          correlationId,
        ),
      );
  }

  /**
   * ValidationPipe, mesajları bir DİZİ olarak BadRequestException'a verir.
   * Nest'in HttpException.initMessage()'i dizi gördüğünde response.message'ı
   * string bulamaz ve exception.message'ı sınıf adına ("Bad Request Exception")
   * düşürür — yani DtoPrefix eşleşmesi asla tutmaz. Gerçek mesajlar
   * getResponse().message içinde durur; burada her iki biçim de tek bir
   * diziye normalize edilir.
   */
  private extractMessages(exception: HttpException): string[] {
    const res = exception.getResponse();

    if (typeof res === 'string') return [res];

    if (res && typeof res === 'object') {
      const raw = (res as { message?: unknown }).message;
      if (Array.isArray(raw)) return raw.map((m) => String(m));
      if (typeof raw === 'string') return [raw];
    }

    return [exception.message];
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
