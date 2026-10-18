import {
  addDays,
  businessDate,
  businessMonth,
  monthDays,
  monthWeeks,
  nextMonth,
  zonedMidnightToUtc,
} from './stock-sales.dates';

describe('stock-sales.dates', () => {
  // ---Amaç: İstanbul'da günün başlangıcının UTC karşılığının doğru hesaplandığını doğrulamak ---
  it.each([
    ['2026-10-01', '2026-09-30T21:00:00.000Z'],
    ['2026-01-01', '2025-12-31T21:00:00.000Z'],
    ['2026-03-29', '2026-03-28T21:00:00.000Z'],
  ])('%s İstanbul gece yarısı → %s', (date, expected) =>
    expect(zonedMidnightToUtc(date).toISOString()).toBe(expected),
  );

  // ---Amaç: bir anın İstanbul tarihine ve ayına göre sınıflandığını doğrulamak ---
  it('UTC gece yarısından önceki an İstanbul’da ertesi güne ve aya düşer', () => {
    const instant = new Date('2026-09-30T21:30:00.000Z');
    expect(businessDate(instant)).toBe('2026-10-01');
    expect(businessMonth(instant)).toBe('2026-10');
    expect(businessMonth(new Date('2026-09-30T20:59:59.000Z'))).toBe('2026-09');
  });

  // ---Amaç: ayın tüm günlerinin artık yıl dahil doğru üretildiğini ve tarih aritmetiğinin ay/yıl geçişlerinde doğru çalıştığını doğrulamak ---
  it('ay günleri, sonraki ay ve gün ekleme sınırlarda doğrudur', () => {
    expect(monthDays('2026-10')).toHaveLength(31);
    expect(monthDays('2026-02')).toHaveLength(28);
    expect(monthDays('2028-02')).toHaveLength(29);
    expect(monthDays('2026-10')[0]).toBe('2026-10-01');
    expect(monthDays('2026-10')[30]).toBe('2026-10-31');
    expect(nextMonth('2026-10')).toBe('2026-11');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  // ---Amaç: haftaların Pazartesi–Pazar olarak bölündüğünü ve ayın ilk/son haftasının aya kırpıldığını doğrulamak ---
  it.each([
    [
      '2026-10',
      [
        ['2026-10-01', '2026-10-04'],
        ['2026-10-05', '2026-10-11'],
        ['2026-10-12', '2026-10-18'],
        ['2026-10-19', '2026-10-25'],
        ['2026-10-26', '2026-10-31'],
      ],
    ],
    [
      '2026-06',
      [
        ['2026-06-01', '2026-06-07'],
        ['2026-06-08', '2026-06-14'],
        ['2026-06-15', '2026-06-21'],
        ['2026-06-22', '2026-06-28'],
        ['2026-06-29', '2026-06-30'],
      ],
    ],
  ])('%s haftaları', (month, expected) => {
    const weeks = monthWeeks(month);
    expect(weeks.map((week) => [week.weekStart, week.weekEnd])).toEqual(
      expected,
    );
    expect(weeks.flatMap((week) => week.days)).toEqual(monthDays(month));
  });
});
