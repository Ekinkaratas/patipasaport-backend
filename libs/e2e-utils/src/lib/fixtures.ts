import { calcVknCheckDigit } from '@libs/common';
import { randomInt, randomUUID } from 'crypto';

export const randomDigits = (length: number): string =>
  Array.from({ length }, () => randomInt(0, 10)).join('');

export const uniqueEmail = (label: string): string =>
  `e2e-${label}-${randomUUID()}@pati.invalid`;

export const uniqueMobilePhone = (): string => `+905${randomDigits(9)}`;

export const uniqueLandlinePhone = (): string => `+90216${randomDigits(7)}`;

export const validVkn = (): string => {
  const firstNine = randomDigits(9);
  return firstNine + calcVknCheckDigit(firstNine);
};

export const istanbulToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export const shiftDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
