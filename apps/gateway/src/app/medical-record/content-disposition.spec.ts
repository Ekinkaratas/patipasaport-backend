import { contentDisposition } from './content-disposition';

describe('contentDisposition', () => {
  // ---Amaç: Türkçe karakterli adın UTF-8 ile kodlandığını ve eski tarayıcılar için ASCII yedeğinin üretildiğini doğrulamak ---
  it('Türkçe adı filename* içinde UTF-8 kodlar, yedek adda ASCII dışını _ yapar', () =>
    expect(contentDisposition('inline', 'Kan Tahlili ğüşiöç İ.pdf')).toBe(
      'inline; filename="Kan Tahlili ___i__ _.pdf"; filename*=UTF-8\'\'Kan%20Tahlili%20%C4%9F%C3%BC%C5%9Fi%C3%B6%C3%A7%20%C4%B0.pdf',
    ));

  // ---Amaç: başlığı bozabilecek karakterlerin yedek adda değiştirildiğini, filename* içinde RFC 5987'ye göre kodlandığını doğrulamak ---
  it('tırnak, ters bölü, yüzde ve RFC 5987 dışı işaretler güvenli hale gelir', () =>
    expect(contentDisposition('attachment', `a"b\\c%d(e)'f*.pdf`)).toBe(
      "attachment; filename=\"a_b_c_d(e)'f*.pdf\"; filename*=UTF-8''a%22b%5Cc%25d%28e%29%27f%2A.pdf",
    ));

  // ---Amaç: dört baytlık karakterin yedek adda tek _ olduğunu doğrulamak ---
  it('emoji yedek adda tek _ olur', () =>
    expect(contentDisposition('inline', '😀.png')).toBe(
      'inline; filename="_.png"; filename*=UTF-8\'\'%F0%9F%98%80.png',
    ));
});
