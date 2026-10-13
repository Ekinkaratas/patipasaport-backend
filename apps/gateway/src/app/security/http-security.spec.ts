import { parseCorsOrigins } from './http-security';

describe('parseCorsOrigins', () => {
  // ---Amaç: boş ya da tanımsız değerin hiçbir origin'e izin vermediğini doğrulamak ---
  it.each([
    ['tanımsız', undefined],
    ['boş', ''],
    ['yalnızca boşluk ve virgül', ' , ,'],
  ])('%s değer boş liste döner', (_n, raw) => {
    expect(parseCorsOrigins(raw)).toEqual([]);
  });

  // ---Amaç: virgülle ayrılmış listenin boşlukları atılarak sırayla döndüğünü doğrulamak ---
  it('virgülle ayrılmış origin listesini boşlukları atarak döner', () => {
    expect(
      parseCorsOrigins(
        ' http://localhost:5173 ,https://app.example.com, https://api.example.com:8443 ',
      ),
    ).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
      'https://api.example.com:8443',
    ]);
  });

  // ---Amaç: tarayıcının gönderdiği Origin biçimine uymayan her değerin açık bir hatayla reddedildiğini doğrulamak ---
  it.each([
    ['joker', '*'],
    ['null origin', 'null'],
    ['sonda eğik çizgi', 'http://localhost:5173/'],
    ['yol içeren adres', 'https://app.example.com/giris'],
    ['http(s) dışı şema', 'ftp://files.example.com'],
    ['şemasız adres', 'localhost:5173'],
    ['büyük harfli adres', 'HTTPS://APP.EXAMPLE.COM'],
    ['varsayılan portu yazılmış adres', 'https://app.example.com:443'],
  ])('%s reddedilir', (_n, invalid) => {
    expect(() =>
      parseCorsOrigins(`https://app.example.com,${invalid}`),
    ).toThrow(`CORS_ORIGINS geçersiz origin içeriyor: "${invalid}"`);
  });
});
