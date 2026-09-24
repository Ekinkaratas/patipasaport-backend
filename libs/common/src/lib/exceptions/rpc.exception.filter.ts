import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Observable, throwError } from 'rxjs';
import { DtoPrefix, GrpcStatusMap, ResponseMessages } from '../enums';

interface GrpcError {
  code: status;
  details: string;
  message: string;
}

@Catch()
export class RpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RpcExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): Observable<never> {
    void host;
    return throwError(() => this.toGrpcError(exception));
  }

  private toGrpcError(exception: unknown): GrpcError {
    const message = this.extractMessage(exception);

    if (message) {
      if (
        Object.values(ResponseMessages).includes(message as ResponseMessages)
      ) {
        const code = message as ResponseMessages;
        return { code: GrpcStatusMap[code], details: code, message: code };
      }

      if (
        Object.values(DtoPrefix).some((prefix) => message.startsWith(prefix))
      ) {
        return {
          code: status.INVALID_ARGUMENT,
          details: message,
          message,
        };
      }
    }

    this.logger.error(
      exception instanceof Error
        ? `Beklenmeyen hata: ${exception.name}: ${exception.message}`
        : `Beklenmeyen hata: ${String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    return {
      code: status.INTERNAL,
      details: ResponseMessages.INTERNAL_SERVER_ERROR,
      message: ResponseMessages.INTERNAL_SERVER_ERROR,
    };
  }

  private extractMessage(exception: unknown): string | null {
    const raw =
      exception instanceof RpcException ? exception.getError() : exception;

    if (typeof raw === 'string') return raw;

    if (typeof raw === 'object' && raw !== null && 'message' in raw) {
      const value = (raw as { message: unknown }).message;
      return typeof value === 'string' ? value : null;
    }

    return null;
  }
}
