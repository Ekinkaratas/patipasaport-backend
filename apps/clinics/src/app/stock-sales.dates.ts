import { BUSINESS_TIME_ZONE } from '@libs/dto';

export interface SalesWeek {
  weekStart: string;
  weekEnd: string;
  days: string[];
}

const pad = (value: number): string => String(value).padStart(2, '0');

const parseDate = (date: string): [number, number, number] => {
  const [year, month, day] = date.split('-').map(Number);
  return [year, month, day];
};

export function businessDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function businessMonth(instant: Date): string {
  return businessDate(instant).slice(0, 7);
}

export function zonedMidnightToUtc(date: string): Date {
  const [year, month, day] = parseDate(date);
  const utcGuess = Date.UTC(year, month - 1, day);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return new Date(utcGuess - (local - utcGuess));
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

export function nextMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${pad(monthNumber + 1)}`;
}

export function monthDays(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`);
}

export function monthWeeks(month: string): SalesWeek[] {
  const weeks: string[][] = [];
  let current: string[] = [];
  for (const day of monthDays(month)) {
    const [year, monthNumber, dayNumber] = parseDate(day);
    const isMonday =
      new Date(Date.UTC(year, monthNumber - 1, dayNumber)).getUTCDay() === 1;
    if (isMonday && current.length > 0) {
      weeks.push(current);
      current = [];
    }
    current.push(day);
  }
  if (current.length > 0) weeks.push(current);
  return weeks.map((days) => ({
    weekStart: days[0],
    weekEnd: days[days.length - 1],
    days,
  }));
}
