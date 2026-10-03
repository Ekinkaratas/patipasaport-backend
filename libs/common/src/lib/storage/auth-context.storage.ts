import { correlationStorage } from './correlation.storage';

/** access.proto: JWT iç servislere metadata'da 'authorization' olarak taşınır. */
export const AUTHORIZATION_METADATA_KEY = 'authorization';

const ACCESS_JWT_KEY = 'accessJwt';

export function setRequestJwt(jwt: string): void {
  const store = correlationStorage.getStore();
  if (!store) {
    throw new Error(
      'setRequestJwt: istek bağlamı yok (CorrelationMiddleware çalışmadı mı?)',
    );
  }
  store.set(ACCESS_JWT_KEY, jwt);
}

export function getRequestJwt(): string | undefined {
  return correlationStorage.getStore()?.get(ACCESS_JWT_KEY);
}
