const VKN_PATTERN = /^\d{10}$/;
const TCKN_PATTERN = /^[1-9]\d{10}$/;

export function calcVknCheckDigit(firstNine: string): string {
  let sum = 0;
  for (let i = 1; i <= 9; i++) {
    const remainder = (Number(firstNine[9 - i]) + i) % 10;
    if (remainder) {
      sum += (remainder * 2 ** i) % 9 || 9;
    }
  }
  return String((10 - (sum % 10)) % 10);
}

export function calcTcknCheckDigits(firstNine: string): string {
  const digits = [...firstNine].map(Number);
  const weighted = digits.reduce(
    (acc, digit, i) => acc + (i % 2 === 0 ? 3 : 1) * digit,
    0,
  );
  const first = (10 - (weighted % 10)) % 10;
  const second = (first + digits.reduce((acc, digit) => acc + digit, 0)) % 10;
  return `${first}${second}`;
}

export function isValidTrTaxNumber(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (VKN_PATTERN.test(value)) {
    return calcVknCheckDigit(value.slice(0, 9)) === value.slice(9);
  }
  if (TCKN_PATTERN.test(value)) {
    return calcTcknCheckDigits(value.slice(0, 9)) === value.slice(9);
  }
  return false;
}
