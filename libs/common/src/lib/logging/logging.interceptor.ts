import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { LogAction, LogActionMap, LogPayload } from '../enums';
import { DtoPrefix, ResponseMessages } from '../enums/messages';
import { RpcException } from '@nestjs/microservices';
import { getCorrelationId } from '../storage';
import { getAuthUser } from '../guards/auth-user';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: Logger;

  constructor(private readonly serviceName: string) {
    this.logger = new Logger(`RequestLog:${serviceName}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const rpcCtx = context.switchToRpc().getContext();
    const correlationId = getCorrelationId();
    const userId = getAuthUser(rpcCtx)?.userId ?? null;
    const method = context.getHandler().name;

    const base = { correlationId, userId, service: this.serviceName, method };

    const receivedLog: LogPayload = {
      ...base,
      action: LogAction.REQUEST_RECEIVED,
      timestamp: new Date().toISOString(),
    };
    this.logger.log(receivedLog);

    return next.handle().pipe(
      tap(() => {
        const successLog: LogPayload = {
          ...base,
          action: LogAction.REQUEST_SUCCESS,
          timestamp: new Date().toISOString(),
        };
        this.logger.log(successLog);
      }),
      catchError((err) => {
        const rpcError = err instanceof RpcException ? err.getError() : err;

        const errorMessage =
          typeof rpcError === 'object' &&
          rpcError !== null &&
          'message' in rpcError
            ? (rpcError as { message: string }).message
            : typeof rpcError === 'string'
              ? rpcError
              : null;

        const isValidationMessage =
          !!errorMessage &&
          Object.values(DtoPrefix).some((prefix) =>
            errorMessage.startsWith(prefix),
          );

        const isKnownCode =
          !!errorMessage &&
          Object.values(ResponseMessages).includes(
            errorMessage as ResponseMessages,
          );

        const finalErrorCode = isKnownCode
          ? (errorMessage as ResponseMessages)
          : ResponseMessages.INTERNAL_SERVER_ERROR;

        const action = isValidationMessage
          ? LogAction.VALIDATION_FAILED
          : (LogActionMap[finalErrorCode] ?? LogAction.REQUEST_FAILED);

        const errorLog: LogPayload = {
          ...base,
          action,
          errorCode: isValidationMessage
            ? (errorMessage as string)
            : finalErrorCode,
          timestamp: new Date().toISOString(),
        };
        this.logger.error(errorLog);

        return throwError(() => err);
      }),
    );
  }
}
