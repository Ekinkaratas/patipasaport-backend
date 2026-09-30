import { InterceptingCall, Interceptor } from '@grpc/grpc-js';

/**
 * Servisten servise çağrı sınırı (ör. auth → users, auth → access).
 * İç çağrıların hepsi tek satırlık DB/Redis işlemleri.
 */
export const GRPC_INTERNAL_TIMEOUT_MS = 5_000;

/**
 * Gateway → servis çağrı sınırı. İç sınırla AYNI olamaz: en uzun başarılı iç
 * zincirden büyük olmalı. Register/Login art arda 2 iç çağrı yapar
 * (2 × 5 sn + argon2/DB), gateway bundan önce vazgeçerse istemci hata alır
 * ama işlem arka planda başarıyla biter.
 */
export const GRPC_GATEWAY_TIMEOUT_MS = 15_000;

/**
 * Giden her gRPC çağrısına deadline koyan client interceptor.
 *
 * Süre dolunca grpc-js çağrıyı DEADLINE_EXCEEDED koduyla bitirir; deadline
 * 'grpc-timeout' başlığıyla karşı servise de iletilir, o taraf da çağrıyı
 * iptal edilmiş görür. Çağıran kendi deadline'ını verdiyse ona dokunulmaz.
 *
 * Kullanım (ClientsModule): channelOptions.interceptors dizisine eklenir.
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
