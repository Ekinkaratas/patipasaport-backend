import {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { lastValueFrom, Observable, of } from 'rxjs';
import { BaseResponse, ResponseMessages } from '@libs/common';
import { auth } from '@libs/proto';
import {
  parseRefreshCookiePath,
  readCookie,
  REFRESH_COOKIE_NAME,
  RefreshCookie,
  RefreshCookieService,
} from './refresh-cookie';

interface CookieCall {
  name: string;
  value?: string;
  options: Record<string, unknown>;
}

const tokenResponse = (): BaseResponse<auth.TokenResponse> =>
  new BaseResponse(
    {
      accessToken: 'opaque-abc',
      refreshToken: 'refresh-abc',
      tokenType: 'Bearer',
      expiresIn: 900,
      userId: 'kullanici-1',
      clinicId: '',
      refreshExpiresIn: 43_200,
    },
    ResponseMessages.SUCCESS,
    true,
    'korelasyon-1',
  );

const httpContext = (headers: Record<string, string>, body: object = {}) => {
  const request = { headers, body } as { headers: object; body: object };
  const set: CookieCall[] = [];
  const cleared: CookieCall[] = [];
  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      set.push({ name, value, options }),
    clearCookie: (name: string, options: Record<string, unknown>) =>
      cleared.push({ name, options }),
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, request, set, cleared };
};

const run = (
  interceptor: NestInterceptor,
  context: ExecutionContext,
  next: CallHandler,
) => lastValueFrom(interceptor.intercept(context, next) as Observable<unknown>);

const handlerReturning = (value: unknown) => {
  const handle = jest.fn(() => of(value));
  return { next: { handle } as CallHandler, handle };
};

describe('parseRefreshCookiePath', () => {
  // ---Amaç: boş değerde frontend'in /api önekine uyan varsayılan yolun kullanıldığını doğrulamak ---
  it.each([undefined, '', '  '])('%p → /api/auth', (raw) =>
    expect(parseRefreshCookiePath(raw)).toBe('/api/auth'),
  );

  // ---Amaç: / ile başlayan yolun boşlukları atılarak kabul edildiğini doğrulamak ---
  it('geçerli yol kabul edilir', () =>
    expect(parseRefreshCookiePath(' /auth ')).toBe('/auth'));

  // ---Amaç: çerez özniteliği enjekte edebilecek ya da / ile başlamayan yolun açılışı durduran hatayla reddedildiğini doğrulamak ---
  it.each(['api/auth', '/a b', '/a;Domain=evil.example', '/a,b'])(
    '"%s" reddedilir',
    (raw) =>
      expect(() => parseRefreshCookiePath(raw)).toThrow(
        `REFRESH_COOKIE_PATH geçersiz: "${raw}"`,
      ),
  );
});

describe('readCookie', () => {
  // ---Amaç: Cookie başlığından yalnızca adı tam eşleşen çerezin çözülmüş değerinin okunduğunu doğrulamak ---
  it.each([
    ['başlık yok', undefined, undefined],
    ['tek çerez', 'pp_refresh=abc', 'abc'],
    ['araya karışmış', 'a=1; pp_refresh=abc%3D%3D; b=2', 'abc=='],
    ['benzer adlı çerez', 'pp_refresh2=x; xpp_refresh=y', undefined],
    ['boş değer', 'pp_refresh=', undefined],
    ['bozuk yüzde kodlaması', 'pp_refresh=%E0%A4%A', undefined],
  ])('%s', (_n, header, expected) =>
    expect(readCookie(header, REFRESH_COOKIE_NAME)).toBe(expected),
  );
});

describe('RefreshCookieService', () => {
  const service = new RefreshCookieService();

  // ---Amaç: çerezin HttpOnly, Secure, SameSite=Strict ve /api/auth yoluyla, ömrü saniyeden milisaniyeye çevrilerek yazıldığını doğrulamak ---
  it('çerezi güvenli özniteliklerle ve token ömrüyle yazar', () => {
    const set: CookieCall[] = [];
    const response = {
      cookie: (name: string, value: string, options: object) =>
        set.push({ name, value, options: options as Record<string, unknown> }),
    };

    service.set(response as never, 'refresh-abc', 43_200);
    service.set(response as never, 'refresh-def', 0);

    expect(set).toEqual([
      {
        name: 'pp_refresh',
        value: 'refresh-abc',
        options: {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/api/auth',
          maxAge: 43_200_000,
        },
      },
      {
        name: 'pp_refresh',
        value: 'refresh-def',
        options: {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/api/auth',
        },
      },
    ]);
  });
});

describe('RefreshCookie interceptor', () => {
  const service = new RefreshCookieService();
  const Issue = RefreshCookie({ read: false, write: 'set' });
  const Rotate = RefreshCookie({ read: true, write: 'set' });
  const Clear = RefreshCookie({ read: true, write: 'clear' });

  // ---Amaç: web istemcisinde refresh token'ın yanıt gövdesinden çıkarılıp yalnızca çereze yazıldığını doğrulamak ---
  it('web girişinde token gövdeden çıkar ve çereze yazılır', async () => {
    const { context, set } = httpContext({ 'x-client-type': '1' });
    const { next } = handlerReturning(tokenResponse());

    const result = (await run(
      new Issue(service),
      context,
      next,
    )) as BaseResponse<Record<string, unknown>>;

    expect(result.data).not.toHaveProperty('refreshToken');
    expect(result).toMatchObject({
      message: 'SUCCESS',
      success: true,
      correlationId: 'korelasyon-1',
      data: { accessToken: 'opaque-abc', refreshExpiresIn: 43_200 },
    });
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      name: 'pp_refresh',
      value: 'refresh-abc',
      options: { maxAge: 43_200_000 },
    });
  });

  // ---Amaç: mobil istemcide yanıtın değişmediğini ve çerez yazılmadığını doğrulamak ---
  it('mobil girişte token gövdede kalır, çerez yazılmaz', async () => {
    const { context, set } = httpContext({ 'x-client-type': '2' });
    const response = tokenResponse();
    const { next } = handlerReturning(response);

    expect(await run(new Issue(service), context, next)).toBe(response);
    expect(set).toEqual([]);
  });

  // ---Amaç: web yenilemesinde çerezdeki token'ın gövdeye konduğunu, istemcinin gövdeye yazdığı token'ın yok sayıldığını ve yeni token'ın çereze yazıldığını doğrulamak ---
  it('web yenilemesinde token çerezden okunur ve yenisi çereze yazılır', async () => {
    const { context, request, set } = httpContext(
      { 'x-client-type': '1', cookie: 'pp_refresh=cerezdeki-token' },
      { refreshToken: 'govdedeki-token', clientType: 1 },
    );
    const { next } = handlerReturning(tokenResponse());

    await run(new Rotate(service), context, next);

    expect(request.body).toEqual({
      refreshToken: 'cerezdeki-token',
      clientType: 1,
    });
    expect(set[0]).toMatchObject({ value: 'refresh-abc' });
  });

  // ---Amaç: web yenilemesinde çerez yoksa isteğin işleyiciye ulaşmadan 401 UNAUTH ile reddedildiğini doğrulamak ---
  it('web yenilemesinde çerez yoksa 401 UNAUTH', () => {
    const { context } = httpContext({ 'x-client-type': '1' });
    const { next, handle } = handlerReturning(tokenResponse());

    let error: unknown;
    try {
      new Rotate(service).intercept(context, next);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe(
      ResponseMessages.UNAUTH,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  // ---Amaç: logout'ta çerez varsa başlık olmasa bile web sayıldığını, token'ın çerezden alındığını ve çerezin silindiğini doğrulamak ---
  it('logout çerezdeki token ile yapılır ve çerez silinir', async () => {
    const { context, request, cleared, set } = httpContext({
      cookie: 'pp_refresh=cerezdeki-token',
    });
    const logoutResponse = new BaseResponse(
      { success: true },
      ResponseMessages.SUCCESS,
      true,
    );
    const { next } = handlerReturning(logoutResponse);

    expect(await run(new Clear(service), context, next)).toBe(logoutResponse);
    expect(request.body).toEqual({ refreshToken: 'cerezdeki-token' });
    expect(cleared).toEqual([
      {
        name: 'pp_refresh',
        options: {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/api/auth',
        },
      },
    ]);
    expect(set).toEqual([]);
  });

  // ---Amaç: web logout'ta çerez yoksa çerezin yine silindiğini ve 401 UNAUTH döndüğünü doğrulamak ---
  it('web logout çerezsiz gelirse çerez silinir ve 401 UNAUTH döner', () => {
    const { context, cleared } = httpContext({ 'x-client-type': '1' });
    const { next, handle } = handlerReturning(null);

    expect(() => new Clear(service).intercept(context, next)).toThrow(
      UnauthorizedException,
    );
    expect(cleared).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
  });

  // ---Amaç: mobil logout'ta gövdedeki token'a dokunulmadığını ve çerez işlemi yapılmadığını doğrulamak ---
  it('mobil logout gövdedeki token ile değişmeden geçer', async () => {
    const { context, request, cleared } = httpContext(
      {},
      { refreshToken: 'govdedeki-token' },
    );
    const { next } = handlerReturning(null);

    await run(new Clear(service), context, next);

    expect(request.body).toEqual({ refreshToken: 'govdedeki-token' });
    expect(cleared).toEqual([]);
  });
});
