import { AsyncLocalStorage } from 'async_hooks';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const CORRELATION_ID_KEY = 'correlationId';

export const CORRELATION_ID_SYSTEM = 'SYSTEM';

export const CORRELATION_ID_UNKNOWN = 'UNKNOWN';

export const correlationStorage = new AsyncLocalStorage<Map<string, string>>();

export function runWithCorrelationId<T>(
  correlationId: string,
  callback: () => T,
): T {
  const store = new Map<string, string>([[CORRELATION_ID_KEY, correlationId]]);
  return correlationStorage.run(store, callback);
}

export function getCorrelationId(
  fallback: string = CORRELATION_ID_SYSTEM,
): string {
  return correlationStorage.getStore()?.get(CORRELATION_ID_KEY) ?? fallback;
}
