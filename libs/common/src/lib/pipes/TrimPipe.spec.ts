import { ArgumentMetadata, BadRequestException, Logger } from '@nestjs/common';
import { ResponseMessages } from '../enums';
import { TrimPipe } from './TrimPipe';

const BODY: ArgumentMetadata = { type: 'body' };
const PARAMS_BODY: ArgumentMetadata = { type: 'custom', data: 'body' };
const DEPTH_LOG =
  'TrimPipe: JSON gövdesi maksimum derinlik sınırını aştı (Limit: 50)';

const nested = (levels: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
};

const nestedArray = (levels: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = [value];
  return value;
};

const rejection = (fn: () => unknown): BadRequestException => {
  try {
    fn();
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('istisna bekleniyordu');
};

describe('TrimPipe', () => {
  const pipe = new TrimPipe();
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // ---Amaç: gövdedeki iç içe nesne ve dizilerdeki metinlerin kırpıldığını, password alanının olduğu gibi kaldığını doğrulamak ---
  it('iç içe metinleri kırpar, password alanına dokunmaz', () => {
    const body = {
      email: '  kullanici@example.com ',
      password: '  Guclu.Sifre1  ',
      address: { city: ' İzmir ', lines: [' 1. sokak ', 7] },
      age: 3,
    };

    expect(pipe.transform(body, BODY)).toEqual({
      email: 'kullanici@example.com',
      password: '  Guclu.Sifre1  ',
      address: { city: 'İzmir', lines: ['1. sokak', 7] },
      age: 3,
    });
  });

  // ---Amaç: JSON gövdesinden gelen __proto__, constructor ve prototype anahtarlarının her derinlikte silindiğini ve prototipin kirlenmediğini doğrulamak ---
  it('prototype pollution anahtarlarını her derinlikte siler', () => {
    const body = JSON.parse(
      '{"name":" Pati ","__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"nested":{"prototype":"x","items":[{"__proto__":{"isAdmin":true},"note":" a "}]}}',
    );

    const result = pipe.transform(body, BODY);

    expect(result).toEqual({
      name: 'Pati',
      nested: { items: [{ note: 'a' }] },
    });
    expect(Object.keys(result)).toEqual(['name', 'nested']);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
      false,
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  // ---Amaç: multer'in ürettiği prototipsiz gövdelerde de anahtarların silindiğini doğrulamak ---
  it('prototipsiz gövdede de anahtarları siler', () => {
    const body = Object.assign(Object.create(null), {
      note: ' sonuç ',
      constructor: 'x',
    });

    expect({ ...pipe.transform(body, BODY) }).toEqual({ note: 'sonuç' });
  });

  // ---Amaç: gövde dışındaki parametrelere dokunulmadığını doğrulamak ---
  it.each(['query', 'param', 'custom'] as const)(
    '%s parametresi değiştirilmez',
    (type) => {
      const value = { search: ' pati ', constructor: 'x' };

      expect(pipe.transform(value, { type })).toEqual({
        search: ' pati ',
        constructor: 'x',
      });
    },
  );

  // ---Amaç: kök dahil 50 seviyelik gövdenin kabul edildiğini ve kırpmanın sürdüğünü doğrulamak ---
  it('50 seviyeye kadar gövdeyi kabul eder ve kırpmaya devam eder', () => {
    const result = pipe.transform({ name: ' Pati ', deep: nested(49) }, BODY);

    expect(result).toEqual({ name: 'Pati', deep: nested(49) });
    expect(warn).not.toHaveBeenCalled();
  });

  // ---Amaç: 50 seviyeyi aşan gövdenin istemci hatası olarak 400 ve Türkçe mesajla reddedildiğini, uyarının loglandığını doğrulamak ---
  it.each([
    ['iç içe nesne', { deep: nested(50) }],
    ['iç içe dizi', { list: nestedArray(50) }],
    ['password altındaki nesne', { password: nested(50) }],
  ])('%s ile 51. seviyeye inen gövde 400 ile reddedilir', (_n, body) => {
    const error = rejection(() => pipe.transform(body, BODY));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      message: ResponseMessages.REQUEST_BODY_TOO_DEEP,
      statusCode: 400,
    });
    expect(ResponseMessages.REQUEST_BODY_TOO_DEEP).toBe(
      'İstek gövdesi çok karmaşık (maksimum derinlik sınırı aşıldı).',
    );
    expect(warn).toHaveBeenCalledWith(DEPTH_LOG);
  });

  // ---Amaç: daha önce yığın taşmasıyla 500'e yol açan çok derin gövdenin artık 400 ile reddedildiğini doğrulamak ---
  it('15000 seviyelik gövde yığın taşması yerine 400 ile reddedilir', () => {
    expect(rejection(() => pipe.transform(nested(15000), BODY))).toBeInstanceOf(
      BadRequestException,
    );
  });

  // ---Amaç: RequestWithParams('body') gövdelerinde yalnızca derinliğin kontrol edildiğini, kırpma ve anahtar silmenin yapılmadığını doğrulamak ---
  it('RequestWithParams gövdesinde yalnızca derinliği kontrol eder', () => {
    const shallow = { name: ' Pati ', constructor: 'x', deep: nested(49) };

    expect(pipe.transform(shallow, PARAMS_BODY)).toEqual({
      name: ' Pati ',
      constructor: 'x',
      deep: nested(49),
    });
    expect(
      rejection(() => pipe.transform({ deep: nested(50) }, PARAMS_BODY)),
    ).toBeInstanceOf(BadRequestException);
    expect(warn).toHaveBeenCalledWith(DEPTH_LOG);
  });

  // ---Amaç: gövde dışından gelen özel parametrelerde derinlik kontrolü yapılmadığını doğrulamak ---
  it('RequestWithParams sorgusunda derinliğe bakılmaz', () => {
    const query = { deep: nested(60) };

    expect(pipe.transform(query, { type: 'custom', data: 'query' })).toBe(
      query,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
