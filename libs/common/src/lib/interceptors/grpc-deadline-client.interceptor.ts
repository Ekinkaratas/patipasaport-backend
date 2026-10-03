import { InterceptingCall, Interceptor } from '@grpc/grpc-js';

/**
 * Servisten servise çağrı sınırı
 */
export const GRPC_INTERNAL_TIMEOUT_MS = 5_000;

/**
 * Gateway → servis çağrı sınırı.
 */
export const GRPC_GATEWAY_TIMEOUT_MS = 15_000;

/**
 * Giden her gRPC çağrısına deadline koyan client interceptor.
 */
export function createGrpcDeadlineInterceptor(timeoutMs: number): Interceptor {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `createGrpcDeadlineInterceptor: geçersiz timeoutMs (${timeoutMs})`,
    );
  }

  return (options, nextCall) =>
    new InterceptingCall(
      nextCall({
        ...options,
        deadline: options.deadline ?? Date.now() + timeoutMs,
      }),
    );
}
