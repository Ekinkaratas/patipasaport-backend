import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import { AdjustStockItemRequestDto } from './adjust-stock-item.dto';
import { DeleteStockItemRequestDto } from './delete-stock-item.dto';
import { UpdateStockItemRequestDto } from './update-stock-item.dto';

const istanbulToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const shiftDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// ---Amaç: stok güncelleme isteğinde gönderilmeyen alanların dokunulmadan kaldığını, null tarihin kaldırma anlamına geldiğini ve gönderilen alanların ekleme kurallarıyla doğrulandığını doğrulamak ---
describe('UpdateStockItemRequestDto', () => {
  const ids = { clinicId: UUID_A, itemId: UUID_B };
  const check = (o: object) =>
    firstErrors(UpdateStockItemRequestDto, { ...ids, ...o });

  it('yalnızca kimlikler hata vermez; gönderilmeyen alanlar tanımsız kalır', () => {
    expect(check({})).toEqual({});
    const dto = plainToInstance(UpdateStockItemRequestDto, ids);
    expect([
      dto.name,
      dto.quantity,
      dto.criticalLevel,
      dto.expiresAt,
      dto.purchasePrice,
      dto.salePrice,
    ]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('sınır değerlerdeki geçerli alanlar kabul edilir', () =>
    expect(
      check({
        name: 'Amoksisilin 500 mg',
        quantity: 0,
        criticalLevel: 100_000,
        expiresAt: istanbulToday(),
        purchasePrice: 0,
        salePrice: 1_000_000_000,
      }),
    ).toEqual({}));

  it.each([
    ['null', null],
    ['boş metin', ''],
  ])('expiresAt %s tarihi kaldırma isteğine ("") dönüşür', (_n, expiresAt) => {
    expect(check({ expiresAt })).toEqual({});
    expect(
      plainToInstance(UpdateStockItemRequestDto, { ...ids, expiresAt })
        .expiresAt,
    ).toBe('');
  });

  it.each([
    [{ name: '' }, 'name', msg(P.STOCK_NAME, V.NOT_EMPTY)],
    [{ name: null }, 'name', msg(P.STOCK_NAME, V.NOT_EMPTY)],
    [{ name: 'a'.repeat(65) }, 'name', msg(P.STOCK_NAME, V.MAX_LENGTH, 64)],
    [{ name: 'Ad<script>' }, 'name', msg(P.STOCK_NAME, V.WRONG_DATA_FORMAT)],
    [{ quantity: null }, 'quantity', msg(P.QUANTITY, V.MUST_BE_NUMBER)],
    [{ quantity: 1.5 }, 'quantity', msg(P.QUANTITY, V.MUST_BE_NUMBER)],
    [{ quantity: -1 }, 'quantity', msg(P.QUANTITY, V.MIN, 0)],
    [{ quantity: 100_001 }, 'quantity', msg(P.QUANTITY, V.MAX, 100_000)],
    [{ criticalLevel: -1 }, 'criticalLevel', msg(P.CRITICAL_LEVEL, V.MIN, 0)],
    [
      { purchasePrice: null },
      'purchasePrice',
      msg(P.PURCHASE_PRICE, V.MUST_BE_NUMBER),
    ],
    [{ purchasePrice: -1 }, 'purchasePrice', msg(P.PURCHASE_PRICE, V.MIN, 0)],
    [{ salePrice: 1.5 }, 'salePrice', msg(P.SALE_PRICE, V.MUST_BE_NUMBER)],
    [
      { purchasePrice: '' },
      'purchasePrice',
      msg(P.PURCHASE_PRICE, V.MUST_BE_NUMBER),
    ],
    [{ salePrice: '   ' }, 'salePrice', msg(P.SALE_PRICE, V.MUST_BE_NUMBER)],
    [
      { salePrice: 1_000_000_001 },
      'salePrice',
      msg(P.SALE_PRICE, V.MAX, 1_000_000_000),
    ],
    [
      { expiresAt: shiftDays(istanbulToday(), -1) },
      'expiresAt',
      msg(P.EXPIRES_AT, V.CANNOT_BE_PAST),
    ],
    [
      { expiresAt: '2027-13-01' },
      'expiresAt',
      msg(P.EXPIRES_AT, V.MUST_BE_DATE),
    ],
    [{ itemId: 'abc' }, 'itemId', msg(P.STOCK_ITEM_ID, V.WRONG_DATA_FORMAT)],
    [{ clinicId: 'abc' }, 'clinicId', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('%j → %s: %s', (override, field, message) =>
    expect(check(override)[field]).toBe(message),
  );
});

// ---Amaç: artış/azalış miktarının sıfırdan farklı, -100.000 ile 100.000 arasında bir tam sayı olması kuralını doğrulamak ---
describe('AdjustStockItemRequestDto', () => {
  const valid = { clinicId: UUID_A, itemId: UUID_B, delta: -3 };
  const check = (o: object) =>
    firstErrors(AdjustStockItemRequestDto, { ...valid, ...o });

  it.each([-100_000, -1, 1, 100_000])('delta %i kabul edilir', (delta) =>
    expect(check({ delta })).toEqual({}),
  );

  it.each([
    [0, msg(P.DELTA, V.NOT_VALID)],
    [100_001, msg(P.DELTA, V.MAX, 100_000)],
    [-100_001, msg(P.DELTA, V.MIN, -100_000)],
    [1.5, msg(P.DELTA, V.MUST_BE_NUMBER)],
    ['beş', msg(P.DELTA, V.MUST_BE_NUMBER)],
    [undefined, msg(P.DELTA, V.MUST_BE_NUMBER)],
  ])('delta %p → %s', (delta, message) =>
    expect(check({ delta })['delta']).toBe(message),
  );

  it('bozuk kalem kimliği reddedilir', () =>
    expect(check({ itemId: 'abc' })['itemId']).toBe(
      msg(P.STOCK_ITEM_ID, V.WRONG_DATA_FORMAT),
    ));
});

// ---Amaç: silme isteğinde klinik ve kalem kimliklerinin UUID olması kuralını doğrulamak ---
describe('DeleteStockItemRequestDto', () => {
  const check = (o: object) =>
    firstErrors(DeleteStockItemRequestDto, {
      clinicId: UUID_A,
      itemId: UUID_B,
      ...o,
    });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    [{ itemId: '' }, 'itemId', msg(P.STOCK_ITEM_ID, V.NOT_EMPTY)],
    [{ itemId: 'abc' }, 'itemId', msg(P.STOCK_ITEM_ID, V.WRONG_DATA_FORMAT)],
    [{ clinicId: 'abc' }, 'clinicId', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('%j → %s: %s', (override, field, message) =>
    expect(check(override)[field]).toBe(message),
  );
});
