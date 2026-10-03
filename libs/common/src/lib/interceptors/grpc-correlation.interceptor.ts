import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  AUTHORIZATION_METADATA_KEY,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_UNKNOWN,
  runWithCorrelationId,
  setRequestJwt,
} from '../storage';

@Injectable()
export class GrpcCorrelationInterceptor implements NestInterceptor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const metadata = context.switchToRpc().getContext();
    const correlationId =
      metadata?.get?.(CORRELATION_ID_HEADER)?.[0]?.toString() ||
      CORRELATION_ID_UNKNOWN;
    const jwt = GrpcCorrelationInterceptor.extractBearer(
      metadata?.get?.(AUTHORIZATION_METADATA_KEY)?.[0]?.toString(),
    );

    return new Observable((subscriber) =>
      runWithCorrelationId(correlationId, () => {
        if (jwt) setRequestJwt(jwt);
        return next.handle().subscribe(subscriber);
      }),
    );
  }

  private static extractBearer(value: string | undefined): string | undefined {
    return value ? /^Bearer\s+(\S+)\s*$/i.exec(value)?.[1] : undefined;
  }
}
