import { Logger } from '@nestjs/common';
import { firstValueFrom, Observable } from 'rxjs';

// --- amaç: dinamik rollback sistemi (dış servisler kullanımına uygun ) ---
export async function rollback<T, K extends keyof T>(
  logger: Logger,
  client: T,
  methodName: K,
  payload: T[K] extends (data: infer P) => unknown ? P : never,
  logContext: string,
): Promise<void> {
  try {
    const grpcMethod = client[methodName] as unknown as (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => Observable<any>;

    await firstValueFrom(grpcMethod.call(client, payload));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);

    logger.error(
      `Rollback Başarısız! Metot: ${String(methodName)} | İşlem: ${logContext} | Nedeni: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
  }
}

// --- amaç: dinamik rollback sistemi (iç servisler kullanımına uygun ) ---
export async function rollbackLocal(
  logger: Logger,
  operation: () => Promise<unknown>,
  logContext: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);

    logger.error(
      `Rollback Başarısız! İşlem: ${logContext} | Nedeni: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
