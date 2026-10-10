import { parse } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

let cachedEnv: Record<string, string> | undefined;

export function rootEnv(): Record<string, string> {
  cachedEnv ??= parse(readFileSync(resolve(WORKSPACE_ROOT, '.env')));
  return cachedEnv;
}

export function requireEnv(name: string): string {
  const value = rootEnv()[name];
  if (!value) {
    throw new Error(`.env içinde ${name} tanımlı değil`);
  }
  return value;
}
