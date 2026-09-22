import { InterceptingCall, Interceptor } from '@grpc/grpc-js';
import { CORRELATION_ID_HEADER, getCorrelationId } from '../storage';

export const grpcCorrelationClientInterceptor: Interceptor = (
  options,
  nextCall,
) =>
  new InterceptingCall(nextCall(options), {
    start(metadata, listener, next) {
      metadata.set(CORRELATION_ID_HEADER, getCorrelationId());
      next(metadata, listener);
    },
  });
