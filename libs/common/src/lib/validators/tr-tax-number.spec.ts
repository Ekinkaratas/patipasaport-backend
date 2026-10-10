import { randomInt } from 'crypto';
import {
  calcTcknCheckDigits,
  calcVknCheckDigit,
  isValidTrTaxNumber,
} from './tr-tax-number';

const randomDigits = (length: number, firstMin = 0): string =>
  Array.from({ length }, (_, i) => randomInt(i === 0 ? firstMin : 0, 10)).join(
    '',
  );

const flipLastDigit = (value: string): string =>
  value.slice(0, -1) + String((Number(value.slice(-1)) + 1) % 10);

describe('calcVknCheckDigit', () => {
  // ---Amaç: python-stdnum (stdnum.tr.vkn) örneğindeki geçerli VKN'nin kontrol hanesini aynı hesapladığını doğrulamak ---
  it('4540536920 için kontrol hanesi 0', () => {
    expect(calcVknCheckDigit('454053692')).toBe('0');
  });

  // ---Amaç: tüm ara değerlerin 0 olduğu sınır durumunda (10 - 0) % 10 = 0 verdiğini doğrulamak ---
  it('1234567890 için kontrol hanesi 0', () => {
    expect(calcVknCheckDigit('123456789')).toBe('0');
  });
});

describe('calcTcknCheckDigits', () => {
  // ---Amaç: python-stdnum (stdnum.tr.tckimlik) örneğindeki geçerli TCKN'nin iki kontrol hanesini aynı hesapladığını doğrulamak ---
  it('17291716060 için kontrol haneleri 60', () => {
    expect(calcTcknCheckDigits('172917160')).toBe('60');
  });
});

describe('isValidTrTaxNumber', () => {
  // ---Amaç: kaynaktaki geçerli VKN ve TCKN örneklerinin kabul edildiğini doğrulamak ---
  it.each(['4540536920', '1234567890', '17291716060'])('%s geçerli', (value) => {
    expect(isValidTrTaxNumber(value)).toBe(true);
  });

  // ---Amaç: kontrol hanesi tutmayan, 0 ile başlayan TCKN, yanlış uzunluk, rakam dışı karakter ve boş girdinin reddedildiğini doğrulamak ---
  it.each([
    '4540536921',
    '17291716050',
    '07291716092',
    '454053692',
    '123456789012',
    'X540536920',
    '4540 53692',
    '',
  ])('%s geçersiz', (value) => {
    expect(isValidTrTaxNumber(value)).toBe(false);
  });

  // ---Amaç: string olmayan girdinin hata fırlatmadan reddedildiğini doğrulamak ---
  it.each([4540536920, null, undefined, {}])('%p geçersiz', (value) => {
    expect(isValidTrTaxNumber(value)).toBe(false);
  });

  // ---Amaç: rastgele üretilen 9 haneye hesaplanan kontrol hanesi eklenince numaranın geçerli, son hane değişince geçersiz olduğunu doğrulamak ---
  it('rastgele VKN: kendi kontrol hanesiyle geçerli, bozulunca geçersiz', () => {
    for (let n = 0; n < 200; n++) {
      const firstNine = randomDigits(9);
      const vkn = firstNine + calcVknCheckDigit(firstNine);
      expect(isValidTrTaxNumber(vkn)).toBe(true);
      expect(isValidTrTaxNumber(flipLastDigit(vkn))).toBe(false);
    }
  });

  // ---Amaç: rastgele üretilen TCKN'lerde iki kontrol hanesinin doğru hesaplandığını ve son hane değişince reddedildiğini doğrulamak ---
  it('rastgele TCKN: kendi kontrol haneleriyle geçerli, bozulunca geçersiz', () => {
    for (let n = 0; n < 200; n++) {
      const firstNine = randomDigits(9, 1);
      const tckn = firstNine + calcTcknCheckDigits(firstNine);
      expect(isValidTrTaxNumber(tckn)).toBe(true);
      expect(isValidTrTaxNumber(flipLastDigit(tckn))).toBe(false);
    }
  });
});
