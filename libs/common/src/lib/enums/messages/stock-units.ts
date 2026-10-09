export const STOCK_UNITS = [
  'PIECE',
  'BOX',
  'BOTTLE',
  'AMPOULE',
  'TABLET',
  'DOSE',
  'ML',
  'MG',
  'G',
] as const;

export type StockUnit = (typeof STOCK_UNITS)[number];
