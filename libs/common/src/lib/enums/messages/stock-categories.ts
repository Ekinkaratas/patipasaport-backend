export const STOCK_CATEGORIES = [
  'VACCINE',
  'MEDICINE',
  'SUPPLY',
  'FOOD',
  'OTHER',
] as const;

export type StockCategory = (typeof STOCK_CATEGORIES)[number];
