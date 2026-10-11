import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';

type Ctor<T> = new () => T;

function collect(
  errors: ValidationError[],
  parent: string,
  result: Record<string, string>,
): void {
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const message = Object.values(error.constraints ?? {})[0];
    if (message) {
      result[path] = message;
    }
    collect(error.children ?? [], path, result);
  }
}

export function nestedErrors<T extends object>(
  cls: Ctor<T>,
  plain: object,
): Record<string, string> {
  const instance = plainToInstance(cls, plain);
  const result: Record<string, string> = {};
  collect(
    validateSync(instance, { whitelist: true, stopAtFirstError: true }),
    '',
    result,
  );
  return result;
}
