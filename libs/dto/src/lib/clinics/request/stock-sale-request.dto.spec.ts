import { DtoPrefix as P, ValidationType as V } from '@libs/common';
import { plainToInstance } from 'class-transformer';
import { firstErrors, msg, UUID_A, UUID_B } from '../../../testing/first-error';
import {
  CancelStockSaleRequestDto,
  CreateStockSaleRequestDto,
  GetStockSalesSummaryRequestDto,
  ListStockSalesRequestDto,
} from './stock-sale.dto';

// ---Amaç: satış isteğinde miktarın 1–100.000 arası tam sayı, isteğe bağlı satış fiyatının 0–1.000.000.000 kuruş arası tam sayı olması kurallarını doğrulamak ---
describe('CreateStockSaleRequestDto', () => {
  const valid = { clinicId: UUID_A, itemId: UUID_B, quantity: 3 };
  const check = (o: object) =>
    firstErrors(CreateStockSaleRequestDto, { ...valid, ...o });

  it('fiyatsız geçerli istek hata vermez, fiyat tanımsız kalır', () => {
    expect(check({})).toEqual({});
    expect(
      plainToInstance(CreateStockSaleRequestDto, valid).unitPrice,
    ).toBeUndefined();
  });

  it.each([1, 100_000])('quantity %p kabul edilir', (quantity) =>
    expect(check({ quantity })).toEqual({}),
  );

  it.each([
    [0, msg(P.QUANTITY, V.MIN, 1)],
    [100_001, msg(P.QUANTITY, V.MAX, 100_000)],
    [1.5, msg(P.QUANTITY, V.MUST_BE_NUMBER)],
    [undefined, msg(P.QUANTITY, V.MUST_BE_NUMBER)],
    [null, msg(P.QUANTITY, V.MUST_BE_NUMBER)],
  ])('quantity %p → %s', (quantity, message) =>
    expect(check({ quantity })['quantity']).toBe(message),
  );

  it.each([0, 14_990, 1_000_000_000])(
    'unitPrice %p kabul edilir',
    (unitPrice) => expect(check({ unitPrice })).toEqual({}),
  );

  it.each([
    [-1, msg(P.UNIT_PRICE, V.MIN, 0)],
    [1_000_000_001, msg(P.UNIT_PRICE, V.MAX, 1_000_000_000)],
    [149.9, msg(P.UNIT_PRICE, V.MUST_BE_NUMBER)],
    [null, msg(P.UNIT_PRICE, V.MUST_BE_NUMBER)],
    ['fiyat', msg(P.UNIT_PRICE, V.MUST_BE_NUMBER)],
    ['', msg(P.UNIT_PRICE, V.MUST_BE_NUMBER)],
  ])('unitPrice %p → %s', (unitPrice, message) =>
    expect(check({ unitPrice })['unitPrice']).toBe(message),
  );

  it.each([
    [{ itemId: undefined }, 'itemId', msg(P.STOCK_ITEM_ID, V.NOT_EMPTY)],
    [{ itemId: 'abc' }, 'itemId', msg(P.STOCK_ITEM_ID, V.WRONG_DATA_FORMAT)],
    [{ clinicId: 'abc' }, 'clinicId', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('%j → %s: %s', (override, field, message) =>
    expect(check(override)[field]).toBe(message),
  );
});

// ---Amaç: satış iptali isteğinde klinik ve satış kimliklerinin UUID olması kuralını doğrulamak ---
describe('CancelStockSaleRequestDto', () => {
  const check = (o: object) =>
    firstErrors(CancelStockSaleRequestDto, {
      clinicId: UUID_A,
      saleId: UUID_B,
      ...o,
    });

  it('geçerli istek hata vermez', () => expect(check({})).toEqual({}));

  it.each([
    [{ saleId: '' }, 'saleId', msg(P.SALE_ID, V.NOT_EMPTY)],
    [{ saleId: 'abc' }, 'saleId', msg(P.SALE_ID, V.WRONG_DATA_FORMAT)],
    [{ clinicId: 'abc' }, 'clinicId', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('%j → %s: %s', (override, field, message) =>
    expect(check(override)[field]).toBe(message),
  );
});

// ---Amaç: satış listesinde tarih filtrelerinin isteğe bağlı olduğunu, bitişin başlangıçtan önce olamayacağını ve sayfalama kurallarını doğrulamak ---
describe('ListStockSalesRequestDto', () => {
  const valid = { clinicId: UUID_A, page: 1, pageSize: 8 };
  const check = (o: object) =>
    firstErrors(ListStockSalesRequestDto, { ...valid, ...o });

  it.each([
    ['tarihsiz', {}],
    ['boş tarihler', { fromDate: '', toDate: '' }],
    ['aynı gün', { fromDate: '2026-10-01', toDate: '2026-10-01' }],
    ['yalnızca bitiş', { toDate: '2026-10-31' }],
  ])('%s kabul edilir', (_n, dates) => expect(check(dates)).toEqual({}));

  it('boş tarih filtresi tanımsız sayılır', () => {
    const dto = plainToInstance(ListStockSalesRequestDto, {
      ...valid,
      fromDate: '',
      toDate: ' ',
    });
    expect([dto.fromDate, dto.toDate]).toEqual([undefined, undefined]);
  });

  it.each([
    [
      { fromDate: '2026-10-05', toDate: '2026-10-04' },
      'toDate',
      msg(P.TO_DATE, V.NOT_VALID),
    ],
    [{ fromDate: '2026-02-30' }, 'fromDate', msg(P.FROM_DATE, V.MUST_BE_DATE)],
    [{ toDate: '01.10.2026' }, 'toDate', msg(P.TO_DATE, V.MUST_BE_DATE)],
    [{ page: 0 }, 'page', msg(P.PAGE, V.MIN, 1)],
    [{ pageSize: 50 }, 'pageSize', msg(P.PAGE_SIZE, V.NOT_VALID)],
    [{ clinicId: 'abc' }, 'clinicId', msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT)],
  ])('%j → %s: %s', (override, field, message) =>
    expect(check(override)[field]).toBe(message),
  );
});

// ---Amaç: aylık rapor isteğinde ayın isteğe bağlı olduğunu, gönderilirse YYYY-AA biçiminde olması gerektiğini doğrulamak ---
describe('GetStockSalesSummaryRequestDto', () => {
  const check = (o: object) =>
    firstErrors(GetStockSalesSummaryRequestDto, { clinicId: UUID_A, ...o });
  const monthOf = (month: unknown) =>
    plainToInstance(GetStockSalesSummaryRequestDto, {
      clinicId: UUID_A,
      month,
    }).month;

  it.each([
    ['gönderilmedi', undefined],
    ['boş', ''],
    ['yalnızca boşluk', '   '],
  ])('ay %s → içinde bulunulan ay için tanımsız kalır', (_n, month) => {
    expect(check({ month })).toEqual({});
    expect(monthOf(month)).toBeUndefined();
  });

  it.each(['2026-01', '2026-10', '2026-12'])('ay %s kabul edilir', (month) =>
    expect(check({ month })).toEqual({}),
  );

  it('ay kenar boşlukları kırpılır', () =>
    expect(monthOf(' 2026-10 ')).toBe('2026-10'));

  it.each(['2026-13', '2026-00', '2026-1', '2026/10', '2026-10-01', '10-2026'])(
    'ay %s → MONTH_WRONG_DATA_FORMAT',
    (month) =>
      expect(check({ month })).toEqual({
        month: msg(P.MONTH, V.WRONG_DATA_FORMAT),
      }),
  );

  it('ay sayı → MONTH_MUST_BE_STRING', () =>
    expect(check({ month: 202610 })).toEqual({
      month: msg(P.MONTH, V.MUST_BE_STRING),
    }));

  it('bozuk klinik kimliği reddedilir', () =>
    expect(check({ clinicId: 'abc' })['clinicId']).toBe(
      msg(P.CLINIC_ID, V.WRONG_DATA_FORMAT),
    ));
});
