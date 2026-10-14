import { requiredEnv } from './required-env';

describe('requiredEnv', () => {
  const NAME = 'REQUIRED_ENV_SPEC_VALUE';

  afterEach(() => {
    delete process.env[NAME];
  });

  // ---Amaç: tanımlı ortam değişkeninin değerinin aynen döndüğünü doğrulamak ---
  it('tanımlı değeri döner', () => {
    process.env[NAME] = 'pets:3005';

    expect(requiredEnv(NAME)).toBe('pets:3005');
  });

  // ---Amaç: eksik ya da boş değişkende servisin değişken adını içeren net bir hatayla durduğunu doğrulamak ---
  it.each([
    ['tanımsız', undefined],
    ['boş', ''],
  ])('%s değişken, adını içeren hatayla durur', (_n, value) => {
    if (value !== undefined) process.env[NAME] = value;

    expect(() => requiredEnv(NAME)).toThrow(
      `${NAME} ortam değişkeni tanımlı değil`,
    );
  });
});
