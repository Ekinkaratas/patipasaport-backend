import { InterceptingCall, Interceptor } from '@grpc/grpc-js';
import { AUTHORIZATION_METADATA_KEY, getRequestJwt } from '../storage';

export const grpcAuthClientInterceptor: Interceptor = (options, nextCall) =>
  new InterceptingCall(nextCall(options), {
    start(metadata, listener, next) {
      const jwt = getRequestJwt();
      if (jwt) {
        metadata.set(AUTHORIZATION_METADATA_KEY, `Bearer ${jwt}`);
      }
      next(metadata, listener);
    },
  });
