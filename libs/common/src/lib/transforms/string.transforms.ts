/**
 * class-transformer @Transform ile kullanılan normalizasyonlar.
 * ValidationPipe({ transform: true }) doğrulamadan ÖNCE çalıştırır;
 * string olmayan değerler olduğu gibi döner, tip hatasını validator yakalar.
 */

/** "  Ali@X.com " -> "ali@x.com" — aynı adresin iki hesap açmasını engeller. */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** "  Ali   Veli " -> "Ali Veli" */
export function normalizeWhitespace(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

const TR_MOBILE_INPUT = /^(?:\+90|0)?(5\d{9})$/;

/**
 * Kabul edilen yazımlar -> "+905551234567" (E.164):
 *   5551234567 / 05551234567 / +905551234567 / "0555 123 45 67"
 * Eşleşmeyen girdi boşlukları silinmiş haliyle döner ve
 * TR_MOBILE_E164_PATTERN doğrulamasında reddedilir.
 */
export function normalizeTrMobilePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const compact = value.replace(/\s+/g, '');
  const match = TR_MOBILE_INPUT.exec(compact);
  return match ? `+90${match[1]}` : compact;
}

/** normalizeTrMobilePhone sonrası beklenen tek format. */
export const TR_MOBILE_E164_PATTERN = /^\+905\d{9}$/;
