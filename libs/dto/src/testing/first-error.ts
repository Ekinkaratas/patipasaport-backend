import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DtoPrefix,
  getValidationMessage,
  ValidationType,
} from '@libs/common';

type Ctor<T> = new () => T;

/**
 * Gateway ve gRPC pipe'larındaki ayarla (transform + stopAtFirstError)
 * doğrular; her alan için DÖNEN İLK mesajı verir. Hata yoksa {}.
 *
 * class-validator dekoratörleri aşağıdan yukarıya çalıştırır; bu testler
 * dekoratör sırası bozulduğunda yanlış mesajın döndüğünü yakalar.
 */
export function firstErrors<T extends object>(
  cls: Ctor<T>,
  plain: object,
): Record<string, string> {
  const instance = plainToInstance(cls, plain);
  const result: Record<string, string> = {};
  for (const error of validateSync(instance, {
    whitelist: true,
    stopAtFirstError: true,
  })) {
    result[error.property] = Object.values(error.constraints ?? {})[0];
  }
  return result;
}

export const msg = (
  prefix: DtoPrefix,
  type: ValidationType,
  ...args: unknown[]
): string => getValidationMessage(prefix, type, ...args);

export const UUID_A = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
export const UUID_B = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
