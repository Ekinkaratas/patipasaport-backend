import { validateLabExplanation } from './lab-explanation-content';

const TEST_NAMES = new Set(['ALT', 'Kreatinin', 'A\tB']);

const valid = () => ({
  summary: 'Değerlerin çoğu referans aralığında.',
  items: [{ testName: 'ALT', explanation: 'ALT karaciğer enzimidir.' }],
});

const check = (raw: unknown, confidence = 0.8, names = TEST_NAMES) =>
  validateLabExplanation(raw, confidence, names);

describe('validateLabExplanation', () => {
  it('geçerli içerik kırpılmış değerlerle döner, şema dışı alanlar atılır', () =>
    expect(
      check({
        summary: '  Özet.\nİkinci satır.  ',
        items: [
          {
            testName: ' ALT ',
            explanation: ' Açıklama.\r\nDevamı. ',
            score: 1,
          },
        ],
        extra: true,
      }),
    ).toEqual({
      summary: 'Özet.\nİkinci satır.',
      items: [{ testName: 'ALT', explanation: 'Açıklama.\r\nDevamı.' }],
      confidence: 0.8,
    }));

  it('snake_case test_name okunur', () =>
    expect(
      check({
        summary: 'Özet',
        items: [{ test_name: 'Kreatinin', explanation: 'Böbrek değeri.' }],
      })?.items,
    ).toEqual([{ testName: 'Kreatinin', explanation: 'Böbrek değeri.' }]));

  it.each([
    ['yok', undefined],
    ['null', null],
    ['boş dizi', []],
  ])('items %s → boş liste', (_n, items) =>
    expect(check({ summary: 'Özet', items })?.items).toEqual([]),
  );

  it.each([
    [1.5, 1],
    [-0.2, 0],
    [0, 0],
    [1, 1],
    [0.42, 0.42],
  ])('confidence %p → %p', (confidence, expected) =>
    expect(check(valid(), confidence)?.confidence).toBe(expected),
  );

  it.each([NaN, Infinity, -Infinity])('confidence %p → geçersiz', (value) =>
    expect(check(valid(), value)).toBeNull(),
  );

  it('summary 2000 karakter geçerli; varyasyon seçicisi uzunluğa sayılmaz', () => {
    expect(check({ summary: 'a'.repeat(2000) })).not.toBeNull();
    expect(check({ summary: `${'a'.repeat(1999)}❤️` })).not.toBeNull();
  });

  it('açıklama 500 karakter geçerli', () =>
    expect(
      check({
        summary: 'Özet',
        items: [{ testName: 'ALT', explanation: 'b'.repeat(500) }],
      }),
    ).not.toBeNull());

  it('50 kalem geçerli, 51 kalem geçersiz', () => {
    const names = Array.from({ length: 51 }, (_v, i) => `Test ${i}`);
    const items = names.map((testName) => ({ testName, explanation: 'Açık' }));
    const known = new Set(names);
    expect(
      check({ summary: 'Özet', items: items.slice(0, 50) }, 0.5, known),
    ).not.toBeNull();
    expect(check({ summary: 'Özet', items }, 0.5, known)).toBeNull();
  });

  it.each([
    ['explanation metin', 'metin'],
    ['explanation dizi', []],
    ['explanation yok', undefined],
    ['summary yok', { items: [] }],
    ['summary yalnızca boşluk', { summary: '   ' }],
    ['summary metin değil', { summary: 123 }],
    ['summary 2001 karakter', { summary: 'a'.repeat(2001) }],
    ['summary sekme içerir', { summary: 'a\tb' }],
    ['items nesne', { summary: 'Özet', items: {} }],
    ['kalem null', { summary: 'Özet', items: [null] }],
    ['kalem metin', { summary: 'Özet', items: ['ALT'] }],
    [
      'testName kayıtta yok',
      { summary: 'Özet', items: [{ testName: 'AST', explanation: 'x' }] },
    ],
    [
      'testName büyük/küçük harf farklı',
      { summary: 'Özet', items: [{ testName: 'alt', explanation: 'x' }] },
    ],
    [
      'testName kontrol karakteri içerir',
      { summary: 'Özet', items: [{ testName: 'A\tB', explanation: 'x' }] },
    ],
    [
      'testName metin değil',
      { summary: 'Özet', items: [{ testName: 5, explanation: 'x' }] },
    ],
    [
      'açıklama yalnızca boşluk',
      { summary: 'Özet', items: [{ testName: 'ALT', explanation: '  ' }] },
    ],
    [
      'açıklama 501 karakter',
      {
        summary: 'Özet',
        items: [{ testName: 'ALT', explanation: 'b'.repeat(501) }],
      },
    ],
    [
      'açıklama kontrol karakteri içerir',
      {
        summary: 'Özet',
        items: [{ testName: 'ALT', explanation: 'a\u0000b' }],
      },
    ],
    ['açıklama yok', { summary: 'Özet', items: [{ testName: 'ALT' }] }],
    [
      'aynı test iki kez',
      {
        summary: 'Özet',
        items: [
          { testName: 'ALT', explanation: 'x' },
          { testName: ' ALT', explanation: 'y' },
        ],
      },
    ],
  ])('%s → geçersiz', (_n, raw) => expect(check(raw)).toBeNull());
});
