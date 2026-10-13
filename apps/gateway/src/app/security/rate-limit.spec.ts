import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import {
  createThrottlerOptions,
  DEFAULT_RATE_LIMITS,
  GatewayThrottlerGuard,
  RateLimit,
  RateLimitConfig,
  readRateLimitConfig,
} from './rate-limit';

class Routes {
  @RateLimit('auth')
  login(): void {
    return;
  }

  @RateLimit('auth')
  register(): void {
    return;
  }

  @RateLimit('upload')
  upload(): void {
    return;
  }

  listPets(): void {
    return;
  }

  listConsents(): void {
    return;
  }
}

type RouteName = Exclude<keyof Routes, 'constructor'>;

interface FakeHttp {
  context: ExecutionContext;
  headers: Record<string, string>;
}

const httpContext = (route: RouteName, ip = '203.0.113.10'): FakeHttp => {
  const headers: Record<string, string> = {};
  const setHeader = (name: string, value: unknown) => {
    headers[name] = String(value);
  };
  const context = {
    getHandler: () => Routes.prototype[route],
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {} }),
      getResponse: () => ({ header: setHeader, setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
};

const limits = (overrides: Partial<RateLimitConfig>): RateLimitConfig => ({
  windowSeconds: 60,
  global: 100,
  auth: 100,
  upload: 100,
  ...overrides,
});

describe('readRateLimitConfig', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // ---Amaç: ortam değişkeni yoksa ya da boşsa onaylanan varsayılan sınırların uyarısız kullanıldığını doğrulamak ---
  it.each([
    ['tanımsız', {}],
    [
      'boş',
      {
        RATE_LIMIT_WINDOW_SECONDS: '',
        RATE_LIMIT_GLOBAL: ' ',
        RATE_LIMIT_AUTH: '',
        RATE_LIMIT_UPLOAD: '',
      },
    ],
  ])('%s değerlerde varsayılanlar kullanılır', (_n, env) => {
    expect(readRateLimitConfig(env)).toEqual({
      windowSeconds: 60,
      global: 100,
      auth: 10,
      upload: 20,
    });
    expect(DEFAULT_RATE_LIMITS).toEqual({
      windowSeconds: 60,
      global: 100,
      auth: 10,
      upload: 20,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // ---Amaç: .env'deki geçerli değerlerin boşlukları atılarak varsayılanları ezdiğini doğrulamak ---
  it('geçerli değerler varsayılanları ezer', () => {
    expect(
      readRateLimitConfig({
        RATE_LIMIT_WINDOW_SECONDS: ' 30 ',
        RATE_LIMIT_GLOBAL: '500',
        RATE_LIMIT_AUTH: '5',
        RATE_LIMIT_UPLOAD: '7',
      }),
    ).toEqual({ windowSeconds: 30, global: 500, auth: 5, upload: 7 });
    expect(warn).not.toHaveBeenCalled();
  });

  // ---Amaç: pozitif tam sayı olmayan değerin yok sayılmadan loglandığını ve varsayılana düşüldüğünü doğrulamak ---
  it.each(['abc', '0', '-5', '1.5', '10s', '9007199254740993'])(
    '"%s" geçersiz sayılır, uyarı loglanır ve varsayılan kullanılır',
    (raw) => {
      expect(readRateLimitConfig({ RATE_LIMIT_AUTH: raw }).auth).toBe(10);
      expect(warn).toHaveBeenCalledWith(
        `RATE_LIMIT_AUTH geçersiz ("${raw}") — varsayılan 10 kullanılıyor`,
      );
    },
  );
});

describe('createThrottlerOptions', () => {
  // ---Amaç: üç sayacın aynı pencereyle kurulduğunu ve anahtarın uçtan bağımsız olarak sayaç adı + IP olduğunu doğrulamak ---
  it('genel, auth ve upload sayaçlarını uçtan bağımsız anahtarla kurar', () => {
    const options = createThrottlerOptions(
      limits({ windowSeconds: 30, global: 50, auth: 5, upload: 7 }),
    );
    if (Array.isArray(options)) throw new Error('nesne biçimi bekleniyordu');

    expect(
      options.throttlers.map(({ name, ttl, limit }) => ({ name, ttl, limit })),
    ).toEqual([
      { name: 'default', ttl: 30_000, limit: 50 },
      { name: 'auth', ttl: 30_000, limit: 5 },
      { name: 'upload', ttl: 30_000, limit: 7 },
    ]);
    expect(
      options.generateKey?.(
        httpContext('login').context,
        '203.0.113.10',
        'auth',
      ),
    ).toBe('auth:203.0.113.10');
  });
});

describe('GatewayThrottlerGuard', () => {
  let storage: ThrottlerStorageService;

  const createGuard = async (config: RateLimitConfig) => {
    storage = new ThrottlerStorageService();
    const guard = new GatewayThrottlerGuard(
      createThrottlerOptions(config),
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
    return guard;
  };

  afterEach(() => {
    storage?.onApplicationShutdown();
  });

  // ---Amaç: genel sınırın farklı uçlara giden istekleri tek sayaçta topladığını ve aşımda standart Retry-After ile 429 fırlattığını doğrulamak ---
  it('genel sınır tüm uçlarda ortak sayılır, aşımda Retry-After ile 429 fırlatır', async () => {
    const guard = await createGuard(limits({ global: 2 }));

    await expect(
      guard.canActivate(httpContext('listPets').context),
    ).resolves.toBe(true);
    await expect(guard.canActivate(httpContext('login').context)).resolves.toBe(
      true,
    );

    const blocked = httpContext('upload');
    const error = await guard.canActivate(blocked.context).catch((e) => e);
    expect(error).toBeInstanceOf(ThrottlerException);
    expect((error as ThrottlerException).getStatus()).toBe(429);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['Retry-After'])).toBeLessThanOrEqual(60);
  });

  // ---Amaç: auth sayacının yalnızca auth uçlarında çalıştığını, bu uçlar arasında ortak olduğunu ve diğer uçları etkilemediğini doğrulamak ---
  it('auth sayacı yalnızca auth uçlarında ve uçlar arasında ortak çalışır', async () => {
    const guard = await createGuard(limits({ auth: 2 }));

    await expect(guard.canActivate(httpContext('login').context)).resolves.toBe(
      true,
    );
    await expect(
      guard.canActivate(httpContext('listPets').context),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext('register').context),
    ).resolves.toBe(true);

    const blocked = httpContext('login');
    await expect(guard.canActivate(blocked.context)).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
    await expect(
      guard.canActivate(httpContext('listConsents').context),
    ).resolves.toBe(true);
  });

  // ---Amaç: yükleme sayacının yalnızca yükleme ucunu sınırladığını doğrulamak ---
  it('upload sayacı yalnızca yükleme ucunu sınırlar', async () => {
    const guard = await createGuard(limits({ upload: 1 }));

    await expect(
      guard.canActivate(httpContext('upload').context),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext('upload').context),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await expect(guard.canActivate(httpContext('login').context)).resolves.toBe(
      true,
    );
  });

  // ---Amaç: sayaçların IP başına tutulduğunu, bir IP'nin aşımının diğerini etkilemediğini doğrulamak ---
  it('sayaçlar IP başına ayrı tutulur', async () => {
    const guard = await createGuard(limits({ global: 1 }));

    await expect(
      guard.canActivate(httpContext('listPets', '203.0.113.10').context),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext('listPets', '203.0.113.10').context),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await expect(
      guard.canActivate(httpContext('listPets', '198.51.100.20').context),
    ).resolves.toBe(true);
  });
});
