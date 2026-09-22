import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_UNKNOWN,
  runWithCorrelationId,
} from '../storage';

@Injectable()
export class GrpcCorrelationInterceptor implements NestInterceptor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const metadata = context.switchToRpc().getContext();
    const correlationId =
      metadata?.get?.(CORRELATION_ID_HEADER)?.[0]?.toString() ||
      CORRELATION_ID_UNKNOWN;

    return new Observable((subscriber) =>
      runWithCorrelationId(correlationId, () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}
