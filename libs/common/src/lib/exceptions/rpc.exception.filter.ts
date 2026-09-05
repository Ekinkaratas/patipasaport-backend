import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable, throwError } from 'rxjs';
import { ResponseMessages } from '../enums';

@Catch()
export class RpcExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): Observable<never> {
    const normalized = this.normalize(exception);
    return throwError(() => normalized);
  }

  private normalize(exception: unknown): RpcException {
    if (exception instanceof RpcException) return exception;
    if (exception instanceof Error) return new RpcException(exception.message);
    if (typeof exception === 'string') return new RpcException(exception);
    return new RpcException(ResponseMessages.INTERNAL_SERVER_ERROR);
  }
}
