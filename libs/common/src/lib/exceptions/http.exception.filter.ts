import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { status } from '@grpc/grpc-js';
import { DtoPrefix } from '../enums/messages/ValidationMessages.enum';
import { ResponseMessages } from '../enums/messages/ResponseMessages.enum';
import { BaseResponse } from '../base/base.response';
import { getStatusFromMessage } from '../enums/mapper/get-status-from-message';
import { getCorrelationId } from '../storage';

interface ResolvedError {
  httpStatus: HttpStatus;
  message: string;
}

@Catch()
export class HttpsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpsExceptionFilter.name);

  private static readonly GRPC_TO_HTTP: Partial<Record<number, HttpStatus>> = {
    [status.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
    [status.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
    [status.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
    [status.NOT_FOUND]: HttpStatus.NOT_FOUND,
    [status.ALREADY_EXISTS]: HttpStatus.CONFLICT,
    [status.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
    [status.UNIMPLEMENTED]: HttpStatus.NOT_IMPLEMENTED,
    [status.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
    [status.DEADLINE_EXCEEDED]: HttpStatus.GATEWAY_TIMEOUT,
  };

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = getCorrelationId();

    const { httpStatus, message } = this.resolve(exception);

    return response
      .status(httpStatus)
      .json(new BaseResponse(null, message, false, correlationId));
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (HttpsExceptionFilter.isGrpcError(exception)) {
      return this.fromGrpcError(exception);
    }

    this.logger.error(
      exception instanceof Error
        ? `Beklenmeyen hata: ${exception.name}: ${exception.message}`
        : `Beklenmeyen hata: ${String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      message: ResponseMessages.INTERNAL_SERVER_ERROR,
    };
  }

  private fromHttpException(exception: HttpException): ResolvedError {
    const httpStatus = exception.getStatus();
    const messages = this.extractMessages(exception);

    const prefixes: DtoPrefix[] = Object.values(DtoPrefix);
    const validationMessage = messages.find((m) =>
      prefixes.some((p) => m.startsWith(p)),
    );
    if (validationMessage) {
      return { httpStatus, message: validationMessage };
    }

    const customMessage = messages.find((m) =>
      Object.values(ResponseMessages).includes(m as ResponseMessages),
    );
    if (customMessage) {
      return { httpStatus, message: customMessage };
    }

    return { httpStatus, message: this.mapStatusToMessage(httpStatus) };
  }

  private fromGrpcError(exception: {
    code: number;
    details?: string;
  }): ResolvedError {
    const details = exception.details ?? '';

    if (Object.values(ResponseMessages).includes(details as ResponseMessages)) {
      return { httpStatus: getStatusFromMessage(details), message: details };
    }

    if (Object.values(DtoPrefix).some((prefix) => details.startsWith(prefix))) {
      return { httpStatus: HttpStatus.BAD_REQUEST, message: details };
    }

    const httpStatus =
      HttpsExceptionFilter.GRPC_TO_HTTP[exception.code] ??
      HttpStatus.INTERNAL_SERVER_ERROR;

    this.logger.error(
      `gRPC çağrısı başarısız (code=${exception.code}): ${details}`,
    );
    return { httpStatus, message: this.mapStatusToMessage(httpStatus) };
  }

  private static isGrpcError(
    value: unknown,
  ): value is { code: number; details?: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { code?: unknown }).code === 'number'
    );
  }

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

  private mapStatusToMessage(httpStatus: number): ResponseMessages {
    switch (httpStatus) {
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
