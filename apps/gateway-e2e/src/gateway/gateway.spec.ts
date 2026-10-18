import { Client } from '@grpc/grpc-js';
import {
  callGrpc,
  DOCKER_GRPC_PORTS,
  DOCKER_REDIS_PORTS,
  EventBus,
  expectOk,
  grpcClient,
  GrpcResult,
  httpGet,
  httpRequest,
  HttpResponse,
  httpUpload,
  istanbulToday,
  JwtIssuer,
  ObjectStore,
  pdfOfSize,
  requireEnv,
  RunningService,
  samplePdf,
  samplePng,
  SeededClinic,
  SeededUser,
  shiftDays,
  startService,
  TestData,
  uniqueEmail,
  uniqueMobilePhone,
} from '@libs/e2e-utils';
import { access, clinics, medicalRecord, pets, users } from '@libs/proto';
import { createHash, randomUUID } from 'crypto';
import { Redis } from 'ioredis';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASSWORD = 'Guclu.Sifre1';
const WEB = { 'x-client-type': '1' };
const MOBILE = { 'x-client-type': '2' };

interface TokenData {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
  userId: string;
}

interface Envelope<T> {
  data: T | null;
  message: string;
  success: boolean;
  correlationId?: string;
}

const parse = <T>(response: HttpResponse): Envelope<T> =>
  JSON.parse(response.body) as Envelope<T>;

const code = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : result.code;

describe('gateway (e2e)', () => {
  let service: RunningService;

  const request = (path: string, headers: Record<string, string> = {}) =>
    httpGet(service.port, path, headers);

  beforeAll(async () => {
    service = await startService('gateway');
  }, 120_000);

  afterAll(async () => {
    await service?.stop();
  });

  // ---Amaç: sağlık ucunun token istemeden yanıt verdiğini doğrulamak ---
  it('GET /health token olmadan 200 ve geçerli zaman damgası döner', async () => {
    const response = await request('/health');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  // ---Amaç: istemcinin gönderdiği geçerli correlation id'nin aynen taşındığını doğrulamak ---
  it.each([
    ['küçük harfli', randomUUID()],
    ['büyük harfli', randomUUID().toUpperCase()],
  ])('%s geçerli UUID x-correlation-id yanıtta aynen döner', async (_n, id) => {
    const response = await request('/health', { 'x-correlation-id': id });
    expect(response.headers['x-correlation-id']).toBe(id);
  });

  // ---Amaç: geçersiz ya da eksik correlation id yerine sunucunun yeni bir UUID ürettiğini doğrulamak ---
  it.each([
    ['UUID olmayan değer', { 'x-correlation-id': 'saldirgan-degeri' }],
    ['başlık yok', {}],
  ])('%s gelirse yeni bir UUID v4 üretilir', async (_n, headers) => {
    const response = await request('/health', headers);
    const id = response.headers['x-correlation-id'];
    expect(id).toMatch(UUID_V4);
    expect(id).not.toBe('saldirgan-degeri');
  });

  // ---Amaç: hata yanıtlarının ortak BaseResponse biçiminde ve aynı correlation id ile döndüğünü doğrulamak ---
  it('bilinmeyen yol 404 ve ortak hata gövdesi döner', async () => {
    const id = randomUUID();
    const response = await request('/olmayan-yol', { 'x-correlation-id': id });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      data: null,
      message: 'NOT_FOUND',
      success: false,
      correlationId: id,
    });
  });

  // ---Amaç: auth uçlarının dışarıya doğru açıldığını, istemci tipini başlıktan aldığını ve yanıtı BaseResponse içinde döndüğünü doğrulamak ---
  describe('auth uçları', () => {
    const data = new TestData();
    const emails: string[] = [];
    const opaqueTokens: string[] = [];
    let accessClient: Client;
    let redis: Redis;

    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) => httpRequest(service.port, 'POST', path, { headers, body });

    const newEmail = (label: string) => {
      const email = uniqueEmail(label);
      emails.push(email);
      return email;
    };

    const track = (response: HttpResponse): Envelope<TokenData> => {
      const envelope = parse<TokenData>(response);
      if (envelope.success && envelope.data) {
        data.trackUser(envelope.data.userId);
        opaqueTokens.push(envelope.data.accessToken);
      }
      return envelope;
    };

    const register = async (
      override: object = {},
      headers: Record<string, string> = WEB,
    ) => {
      const response = await post(
        '/auth/register',
        {
          email: newEmail('gateway'),
          password: PASSWORD,
          fullName: 'Ali Veli',
          phone: uniqueMobilePhone(),
          ...override,
        },
        headers,
      );
      return { response, envelope: track(response) };
    };

    const login = async (
      email: string,
      override: object = {},
      headers: Record<string, string> = WEB,
    ) => {
      const response = await post(
        '/auth/login',
        { email, password: PASSWORD, ...override },
        headers,
      );
      return { response, envelope: track(response) };
    };

    const exchange = (opaqueToken: string, clientType: access.ClientType) =>
      callGrpc<access.ExchangeTokenResponse>(accessClient, 'ExchangeToken', {
        opaqueToken,
        clientType,
      });

    const refreshCookieHeader = (response: HttpResponse): string => {
      const header = response.headers['set-cookie'] ?? [];
      return header.find((cookie) => cookie.startsWith('pp_refresh=')) ?? '';
    };

    const refreshCookieValue = (response: HttpResponse): string =>
      refreshCookieHeader(response).split(';')[0].slice('pp_refresh='.length);

    const withCookie = (
      value: string,
      headers: Record<string, string> = WEB,
    ) => ({
      ...headers,
      cookie: `pp_refresh=${value}`,
    });

    const userRowCount = async (email: string): Promise<number> => {
      const db = await data.db('users');
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM users WHERE email = $1',
        [email],
      );
      return rows[0].n;
    };

    beforeAll(async () => {
      accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
      redis = new Redis({
        host: '127.0.0.1',
        port: DOCKER_REDIS_PORTS.auth,
        password: requireEnv('AUTH_REDIS_PASSWORD'),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await redis.connect();
    });

    afterAll(async () => {
      try {
        for (const opaqueToken of opaqueTokens) {
          await callGrpc(accessClient, 'RevokeToken', { opaqueToken });
        }
        const keys = emails.flatMap((email) =>
          ['fail', 'lock', 'lock-level'].map(
            (kind) => `auth:login-${kind}:${email}`,
          ),
        );
        if (keys.length > 0) {
          await redis?.del(...keys);
        }
        await data.cleanup();
      } finally {
        await data.close();
        redis?.disconnect();
        accessClient?.close();
      }
    });

    // ---Amaç: web kaydında access token'ın gövdede, refresh token'ın ise yalnızca güvenli httpOnly çerezde döndüğünü ve token'ın istemci tipine bağlı olduğunu doğrulamak ---
    it('POST /auth/register 201; web’de refresh token gövdede değil, güvenli httpOnly çerezde döner', async () => {
      const { response, envelope } = await register();

      expect(response.status).toBe(201);
      expect(envelope).toMatchObject({ message: 'CREATED', success: true });
      expect(envelope.correlationId).toBe(response.headers['x-correlation-id']);
      expect(envelope.data).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshExpiresIn: 43_200,
      });
      expect(envelope.data?.userId).toMatch(UUID_V4);
      expect(envelope.data).not.toHaveProperty('refreshToken');

      const cookie = refreshCookieHeader(response);
      expect(refreshCookieValue(response)).not.toBe('');
      for (const attribute of [
        'Max-Age=43200',
        'Path=/api/auth',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]) {
        expect(cookie.split('; ')).toContain(attribute);
      }

      const token = envelope.data?.accessToken ?? '';
      expect(code(await exchange(token, access.ClientType.WEB))).toBe('ok');
      expect(code(await exchange(token, access.ClientType.MOBILE))).toBe(
        'UNAUTHENTICATED',
      );
    });

    // ---Amaç: mobil kaydın değişmediğini, refresh token'ın gövdede döndüğünü ve çerez yazılmadığını doğrulamak ---
    it('MOBILE başlığıyla kayıt MOBILE token’ı üretir; refresh token gövdededir, çerez yazılmaz', async () => {
      const { response, envelope } = await register({}, MOBILE);
      expect(envelope.data?.refreshToken).toBeTruthy();
      expect(envelope.data?.refreshExpiresIn).toBe(43_200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        code(await exchange(envelope.data?.accessToken ?? '', access.ClientType.MOBILE)),
      ).toBe('ok');
    });

    // ---Amaç: "beni hatırla" ile girişte çerez ömrünün ve refreshExpiresIn değerinin 30 gün olduğunu doğrulamak ---
    it('beni hatırla ile web girişinde çerez ve refresh ömrü 30 gündür', async () => {
      const email = newEmail('gateway');
      await register({ email });

      const { response, envelope } = await login(email, { rememberMe: true });
      expect(envelope.data?.refreshExpiresIn).toBe(2_592_000);
      expect(refreshCookieHeader(response).split('; ')).toContain(
        'Max-Age=2592000',
      );
    });

    it('x-client-type yoksa ya da geçersizse 400 INVALID_CLIENT_TYPE; gövdedeki clientType dikkate alınmaz ve kayıt açılmaz', async () => {
      const invalidHeaders: Record<string, string>[] = [
        {},
        { 'x-client-type': '3' },
      ];
      for (const headers of invalidHeaders) {
        const email = newEmail('gateway');
        const { response, envelope } = await register(
          { email, clientType: 1 },
          headers,
        );
        expect(response.status).toBe(400);
        expect(envelope).toMatchObject({
          data: null,
          message: 'INVALID_CLIENT_TYPE',
          success: false,
        });
        expect(await userRowCount(email)).toBe(0);
      }
    });

    it('gövde gateway’de DTO ile doğrulanır: bozuk e-posta 400 EMAIL_WRONG DATA FORMAT', async () => {
      const { response, envelope } = await register({ email: 'bozuk' });
      expect(response.status).toBe(400);
      expect(envelope.message).toBe('EMAIL_WRONG DATA FORMAT');
    });

    it('kayıtlı e-posta 409 EMAIL_ALREADY_EXISTS alır', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const { response, envelope } = await register({ email });
      expect(response.status).toBe(409);
      expect(envelope.message).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('POST /auth/login 200 SUCCESS; yanlış şifre 401 PASSWORD_OR_EMAIL_WRONG', async () => {
      const email = newEmail('gateway');
      await register({ email });

      const ok = await login(email);
      expect(ok.response.status).toBe(200);
      expect(ok.envelope).toMatchObject({ message: 'SUCCESS', success: true });
      expect(ok.envelope.data?.tokenType).toBe('Bearer');

      const wrong = await login(email, { password: 'Yanlis.Sifre1' });
      expect(wrong.response.status).toBe(401);
      expect(wrong.envelope.message).toBe('PASSWORD_OR_EMAIL_WRONG');
    });

    // ---Amaç: web yenilemesinde token'ın çerezden okunduğunu, gövdedeki token'ın yok sayıldığını, yeni token'ın çereze yazıldığını ve eski çerezin tekrar kullanılamadığını doğrulamak ---
    it('POST /auth/refresh web’de çerezle çalışır; gövdedeki token yok sayılır, eski çerez tekrar kullanılınca 401', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const first = refreshCookieValue((await login(email)).response);

      const refreshed = await post(
        '/auth/refresh',
        { refreshToken: 'govdedeki-gecersiz-token' },
        withCookie(first),
      );
      const envelope = track(refreshed);
      expect(refreshed.status).toBe(200);
      expect(envelope).toMatchObject({ message: 'SUCCESS', success: true });
      expect(envelope.data).not.toHaveProperty('refreshToken');
      const rotated = refreshCookieValue(refreshed);
      expect(rotated).not.toBe('');
      expect(rotated).not.toBe(first);

      const reused = await post('/auth/refresh', {}, withCookie(first));
      expect(reused.status).toBe(401);
      expect(parse(reused).message).toBe('UNAUTH');
    });

    // ---Amaç: web yenilemesinde çerez yoksa gövdede token olsa bile 401 UNAUTH döndüğünü doğrulamak ---
    it('POST /auth/refresh web’de çerez yoksa 401 UNAUTH', async () => {
      const response = await post(
        '/auth/refresh',
        { refreshToken: 'govdedeki-token' },
        WEB,
      );
      expect(response.status).toBe(401);
      expect(parse(response)).toMatchObject({
        data: null,
        message: 'UNAUTH',
        success: false,
      });
    });

    // ---Amaç: mobil yenilemenin değişmediğini, token'ın gövdeden okunup yenisinin gövdede döndüğünü doğrulamak ---
    it('POST /auth/refresh mobilde gövdeyle çalışır; eski refresh token tekrar kullanılınca 401', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const first = (await login(email, {}, MOBILE)).envelope.data as TokenData;

      const refreshed = await post(
        '/auth/refresh',
        { refreshToken: first.refreshToken },
        MOBILE,
      );
      const envelope = track(refreshed);
      expect(refreshed.status).toBe(200);
      expect(envelope.data?.refreshToken).toBeTruthy();
      expect(envelope.data?.refreshToken).not.toBe(first.refreshToken);
      expect(refreshed.headers['set-cookie']).toBeUndefined();

      const reused = await post(
        '/auth/refresh',
        { refreshToken: first.refreshToken },
        MOBILE,
      );
      expect(reused.status).toBe(401);
      expect(parse(reused).message).toBe('UNAUTH');
    });

    // ---Amaç: web logout'ta refresh token'ın çerezden alınıp iptal edildiğini, çerezin silindiğini ve başlıktaki access token'ın da iptal edildiğini doğrulamak ---
    it('POST /auth/logout web’de çerezi kullanır ve siler; access token da iptal edilir', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const { response: loggedIn, envelope } = await login(email);
      const cookie = refreshCookieValue(loggedIn);
      const accessToken = envelope.data?.accessToken ?? '';

      const response = await post(
        '/auth/logout',
        {},
        withCookie(cookie, {
          ...WEB,
          authorization: `Bearer ${accessToken}`,
        }),
      );
      expect(response.status).toBe(200);
      expect(parse(response)).toMatchObject({
        data: { success: true },
        message: 'SUCCESS',
        success: true,
      });
      const cleared = refreshCookieHeader(response).split('; ');
      expect(cleared[0]).toBe('pp_refresh=');
      expect(cleared).toContain('Path=/api/auth');
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

      expect(code(await exchange(accessToken, access.ClientType.WEB))).toBe(
        'UNAUTHENTICATED',
      );
      expect((await post('/auth/refresh', {}, withCookie(cookie))).status).toBe(
        401,
      );
    });

    // ---Amaç: mobil logout'un gövdedeki refresh token'la çalıştığını ve başlıktaki access token'ı da iptal ettiğini doğrulamak ---
    it('POST /auth/logout mobilde gövdeyle çalışır; Authorization başlığındaki access token da iptal edilir', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const tokens = (await login(email, {}, MOBILE)).envelope
        .data as TokenData;

      const response = await post(
        '/auth/logout',
        { refreshToken: tokens.refreshToken },
        { authorization: `Bearer ${tokens.accessToken}` },
      );
      expect(response.status).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        code(await exchange(tokens.accessToken, access.ClientType.MOBILE)),
      ).toBe('UNAUTHENTICATED');
      expect(
        (
          await post(
            '/auth/refresh',
            { refreshToken: tokens.refreshToken },
            MOBILE,
          )
        ).status,
      ).toBe(401);
    });

    it('logout’ta access token yalnızca başlıktan alınır: gövdedeki ya da bozuk başlıktaki token iptal edilmez, refresh token yine iptal edilir', async () => {
      const email = newEmail('gateway');
      await register({ email });

      for (const variant of [
        { body: (t: TokenData) => ({ refreshToken: t.refreshToken, opaqueToken: t.accessToken }), headers: () => ({}) },
        { body: (t: TokenData) => ({ refreshToken: t.refreshToken }), headers: (t: TokenData) => ({ authorization: `Basic ${t.accessToken}` }) },
      ]) {
        const tokens = (await login(email, {}, MOBILE)).envelope
          .data as TokenData;
        const response = await post(
          '/auth/logout',
          variant.body(tokens),
          variant.headers(tokens),
        );
        expect(response.status).toBe(200);
        expect(
          code(await exchange(tokens.accessToken, access.ClientType.MOBILE)),
        ).toBe('ok');
        expect(
          (
            await post(
              '/auth/refresh',
              { refreshToken: tokens.refreshToken },
              MOBILE,
            )
          ).status,
        ).toBe(401);
      }
    });

    it('5 yanlış denemeden sonra doğru şifre de 429 TOO_MANY_REQUESTS alır', async () => {
      const email = newEmail('gateway');
      await register({ email });
      for (let i = 0; i < 5; i++) {
        expect(
          (await login(email, { password: 'Yanlis.Sifre1' })).response.status,
        ).toBe(401);
      }
      const locked = await login(email);
      expect(locked.response.status).toBe(429);
      expect(locked.envelope.message).toBe('TOO_MANY_REQUESTS');
    });

    it('iç RPC RegisterClinicAccount ve eski şablon uç dışarıya açık değildir', async () => {
      for (const path of [
        '/auth/register-clinic-account',
        '/auth/registerClinicAccount',
        '/auth/RegisterClinicAccount',
      ]) {
        expect((await post(path, {}, WEB)).status).toBe(404);
      }
      expect((await request('/auth')).status).toBe(404);
    });
  });

  // ---Amaç: rıza uçlarının yalnızca kullanıcıya yönelik RPC'leri açtığını, token/rol kurallarını ve BaseResponse biçimini doğrulamak ---
  describe('rıza uçları', () => {
    const data = new TestData();
    const tokens = new JwtIssuer();
    const opaqueTokens: string[] = [];
    const OWNER = randomUUID();
    const OTHER_OWNER = randomUUID();

    let accessClient: Client;
    let petsClient: Client;
    let clinic: SeededClinic;
    let passiveClinic: SeededClinic;
    let quietClinic: SeededClinic;
    let petId: string;
    let ownerToken: string;
    let otherOwnerToken: string;
    let clinicToken: string;
    let consentId: string;

    const opaqueTokenFor = async (
      role: 'PET_OWNER' | 'CLINIC',
      userId: string,
      clinicId = '',
    ) => {
      const created = expectOk(
        await callGrpc<access.CreateTokenResponse>(
          accessClient,
          'CreateOpaqueToken',
          {
            userId,
            role,
            clinicId,
            clientType: access.ClientType.WEB,
            ttlSeconds: 0,
          },
        ),
        'access.CreateOpaqueToken',
      );
      opaqueTokens.push(created.opaqueToken);
      return created.opaqueToken;
    };

    const withToken = (token: string) => ({
      authorization: `Bearer ${token}`,
      ...WEB,
    });

    const call = (
      method: string,
      path: string,
      token?: string,
      body?: unknown,
    ) =>
      httpRequest(service.port, method, path, {
        headers: token ? withToken(token) : {},
        body,
      });

    const grantBody = (override: object = {}) => ({
      clinicId: clinic.id,
      petId,
      scopes: ['medical_read'],
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      ...override,
    });

    beforeAll(async () => {
      data.trackUser(OWNER);
      data.trackUser(OTHER_OWNER);
      accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
      petsClient = grpcClient('pets', DOCKER_GRPC_PORTS.pets);

      clinic = await data.insertClinic();
      passiveClinic = await data.insertClinic({ isActive: false });
      quietClinic = await data.insertClinic();

      const pet = expectOk(
        await callGrpc<pets.PetResponse>(
          petsClient,
          'CreatePet',
          {
            name: 'Boncuk',
            species: 'DOG',
            breed: 'KANGAL',
            sex: pets.PetSex.MALE,
            birthDate: '2022-05-10',
            isBirthDateEstimated: false,
            isNeutered: true,
            chipNumber: '',
            ownerUserId: OWNER,
          },
          await tokens.jwtFor({ role: 'PET_OWNER', userId: OWNER }),
        ),
        'pets.CreatePet',
      );
      petId = pet.pet?.id ?? '';
      data.trackPet(petId);

      ownerToken = await opaqueTokenFor('PET_OWNER', OWNER);
      otherOwnerToken = await opaqueTokenFor('PET_OWNER', OTHER_OWNER);
      clinicToken = await opaqueTokenFor('CLINIC', randomUUID(), clinic.id);
    });

    afterAll(async () => {
      try {
        for (const opaqueToken of opaqueTokens) {
          await callGrpc(accessClient, 'RevokeToken', { opaqueToken });
        }
        await data.cleanup();
      } finally {
        await data.close();
        [accessClient, petsClient].forEach((client) => client?.close());
        tokens.close();
      }
    });

    it('token yoksa 401 UNAUTH, x-client-type yoksa 400 INVALID_CLIENT_TYPE', async () => {
      const noToken = await call('POST', '/consents', undefined, grantBody());
      expect(noToken.status).toBe(401);
      expect(parse(noToken).message).toBe('UNAUTH');

      const noClientType = await httpRequest(service.port, 'POST', '/consents', {
        headers: { authorization: `Bearer ${ownerToken}` },
        body: grantBody(),
      });
      expect(noClientType.status).toBe(400);
      expect(parse(noClientType).message).toBe('INVALID_CLIENT_TYPE');
    });

    it('POST /consents 200 SUCCESS ile rızayı verir; aynı klinik + hayvan için tekrar çağrı aynı rızayı günceller', async () => {
      const first = await call('POST', '/consents', ownerToken, grantBody());
      const envelope = parse<access.ConsentResponse>(first);
      expect(first.status).toBe(200);
      expect(envelope).toMatchObject({
        message: 'SUCCESS',
        success: true,
        data: {
          status: access.ConsentStatus.ACTIVE,
          scopes: ['medical_read'],
          ownerUserId: OWNER,
          clinicId: clinic.id,
          petId,
          revokedAt: '',
        },
      });
      expect(envelope.correlationId).toBe(first.headers['x-correlation-id']);
      consentId = envelope.data?.consentId ?? '';

      const again = parse<access.ConsentResponse>(
        await call(
          'POST',
          '/consents',
          ownerToken,
          grantBody({ scopes: ['medical_read', 'vaccination_read'] }),
        ),
      );
      expect(again.data?.consentId).toBe(consentId);
      expect(again.data?.scopes).toEqual(['medical_read', 'vaccination_read']);
    });

    it('rıza vermeyi CLINIC rolü 403 FORBIDDEN alır; gövde gateway’de doğrulanır; pasif klinik 404', async () => {
      const asClinic = await call('POST', '/consents', clinicToken, grantBody());
      expect(asClinic.status).toBe(403);
      expect(parse(asClinic).message).toBe('FORBIDDEN');

      const badScope = await call(
        'POST',
        '/consents',
        ownerToken,
        grantBody({ scopes: ['bilinmeyen_scope'] }),
      );
      expect(badScope.status).toBe(400);
      expect(parse(badScope).message).toBe('SCOPES_NOT_VALID');

      const passive = await call(
        'POST',
        '/consents',
        ownerToken,
        grantBody({ clinicId: passiveClinic.id }),
      );
      expect(passive.status).toBe(404);
      expect(parse(passive).message).toBe('NOT_FOUND');
    });

    it('GET /consents/status rızayı döner; rıza yoksa 200 ve status NOT_FOUND; bozuk id 400', async () => {
      const found = parse<access.ConsentResponse>(
        await call(
          'GET',
          `/consents/status?clinicId=${clinic.id}&petId=${petId}`,
          ownerToken,
        ),
      );
      expect(found).toMatchObject({
        success: true,
        data: { consentId, status: access.ConsentStatus.ACTIVE },
      });

      const missing = await call(
        'GET',
        `/consents/status?clinicId=${quietClinic.id}&petId=${petId}`,
        ownerToken,
      );
      expect(missing.status).toBe(200);
      expect(parse<access.ConsentResponse>(missing).data).toMatchObject({
        consentId: '',
        status: access.ConsentStatus.NOT_FOUND,
      });

      const bad = await call(
        'GET',
        `/consents/status?clinicId=abc&petId=${petId}`,
        ownerToken,
      );
      expect(bad.status).toBe(400);
      expect(parse(bad).message).toBe('CLINIC_ID_WRONG DATA FORMAT');
    });

    it('GET /consents sahibe kendi rızalarını, kliniğe sahip bilgisi olmadan aktif rızalarını listeler; geçersiz sayfa boyu 400', async () => {
      const mine = parse<access.ListMyConsentsResponse>(
        await call('GET', '/consents?page=1&pageSize=8', ownerToken),
      );
      expect(mine).toMatchObject({
        success: true,
        data: { total: 1, page: 1, pageSize: 8 },
      });
      expect(mine.data?.consents[0]).toMatchObject({
        consentId,
        ownerUserId: OWNER,
      });

      const clinicView = parse<access.ListMyConsentsResponse>(
        await call('GET', '/consents?page=1&pageSize=8', clinicToken),
      );
      expect(clinicView.data?.total).toBe(1);
      expect(clinicView.data?.consents[0]).toMatchObject({
        consentId,
        ownerUserId: '',
        status: access.ConsentStatus.ACTIVE,
      });

      const badPageSize = await call(
        'GET',
        '/consents?page=1&pageSize=10',
        ownerToken,
      );
      expect(badPageSize.status).toBe(400);
      expect(parse(badPageSize).message).toBe('PAGE_SIZE_NOT_VALID');
    });

    it('POST /consents/:consentId/revoke: başka sahip 404, bozuk id 400; sahip iptal eder, ikinci iptal 404', async () => {
      expect(
        (await call('POST', `/consents/${consentId}/revoke`, otherOwnerToken))
          .status,
      ).toBe(404);
      expect(
        (await call('POST', '/consents/abc/revoke', ownerToken)).status,
      ).toBe(400);

      const revoked = await call(
        'POST',
        `/consents/${consentId}/revoke`,
        ownerToken,
      );
      expect(revoked.status).toBe(200);
      const envelope = parse<access.ConsentResponse>(revoked);
      expect(envelope).toMatchObject({
        message: 'SUCCESS',
        data: { consentId, status: access.ConsentStatus.REVOKED },
      });
      expect(Number.isNaN(Date.parse(envelope.data?.revokedAt ?? ''))).toBe(
        false,
      );

      const twice = await call(
        'POST',
        `/consents/${consentId}/revoke`,
        ownerToken,
      );
      expect(twice.status).toBe(404);
    });

    it('iç RPC’ler (token üretme/değişme/iptal, CheckAccess) ve eski /access öneki dışarıya açık değildir', async () => {
      for (const path of [
        '/access/create-token',
        '/access/exchange-token',
        '/access/revoke-token',
        '/access/check-access',
        '/consents/check-access',
        '/access/consents',
      ]) {
        expect((await call('POST', path, ownerToken, {})).status).toBe(404);
      }
      expect((await call('GET', '/access', ownerToken)).status).toBe(404);
    });
  });

  // ---Amaç: users, pets ve clinics uçlarının yalnızca kullanıcıya yönelik RPC'leri açtığını, yol parametresi birleştirmesini ve BaseResponse biçimini doğrulamak ---
  describe('kullanıcı, hayvan ve klinik uçları', () => {
    const data = new TestData();
    const opaqueTokens: string[] = [];

    let accessClient: Client;
    let owner: SeededUser;
    let leaver: SeededUser;
    let clinic: SeededClinic;
    let otherClinic: SeededClinic;
    let closingClinic: SeededClinic;
    let ownerToken: string;
    let leaverToken: string;
    let clinicToken: string;
    let otherClinicToken: string;
    let closingClinicToken: string;
    let petId: string;

    const opaqueTokenFor = async (
      role: 'PET_OWNER' | 'CLINIC',
      userId: string,
      clinicId = '',
    ) => {
      const created = expectOk(
        await callGrpc<access.CreateTokenResponse>(
          accessClient,
          'CreateOpaqueToken',
          {
            userId,
            role,
            clinicId,
            clientType: access.ClientType.WEB,
            ttlSeconds: 0,
          },
        ),
        'access.CreateOpaqueToken',
      );
      opaqueTokens.push(created.opaqueToken);
      return created.opaqueToken;
    };

    const call = (
      method: string,
      path: string,
      token: string,
      body?: unknown,
    ) =>
      httpRequest(service.port, method, path, {
        headers: { authorization: `Bearer ${token}`, ...WEB },
        body,
      });

    beforeAll(async () => {
      accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
      owner = await data.insertUser({ fullName: 'Ayşe Yılmaz' });
      leaver = await data.insertUser({ fullName: 'Kapanacak Hesap' });
      clinic = await data.insertClinic();
      otherClinic = await data.insertClinic();
      closingClinic = await data.insertClinic();

      ownerToken = await opaqueTokenFor('PET_OWNER', owner.id);
      leaverToken = await opaqueTokenFor('PET_OWNER', leaver.id);
      clinicToken = await opaqueTokenFor('CLINIC', randomUUID(), clinic.id);
      otherClinicToken = await opaqueTokenFor(
        'CLINIC',
        randomUUID(),
        otherClinic.id,
      );
      closingClinicToken = await opaqueTokenFor(
        'CLINIC',
        randomUUID(),
        closingClinic.id,
      );
    });

    afterAll(async () => {
      try {
        for (const opaqueToken of opaqueTokens) {
          await callGrpc(accessClient, 'RevokeToken', { opaqueToken });
        }
        await data.cleanup();
      } finally {
        await data.close();
        accessClient?.close();
      }
    });

    it('GET /users/me sahibin profilini döner; CLINIC rolü 403', async () => {
      const response = await call('GET', '/users/me', ownerToken);
      expect(response.status).toBe(200);
      expect(parse<users.GetMeResponse>(response)).toMatchObject({
        message: 'SUCCESS',
        success: true,
        data: {
          userId: owner.id,
          fullName: 'Ayşe Yılmaz',
          role: users.UserRole.PET_OWNER,
          isActive: true,
        },
      });
      expect((await call('GET', '/users/me', clinicToken)).status).toBe(403);
    });

    it('PATCH /users/me adı günceller; boş gövde 400 BAD_REQUEST', async () => {
      const updated = await call('PATCH', '/users/me', ownerToken, {
        fullName: '  Ayşe   Kaya ',
      });
      expect(updated.status).toBe(200);
      expect(parse<users.UserResponse>(updated).data?.user?.fullName).toBe(
        'Ayşe Kaya',
      );

      const empty = await call('PATCH', '/users/me', ownerToken, {});
      expect(empty.status).toBe(400);
      expect(parse(empty).message).toBe('BAD_REQUEST');
    });

    it('POST /users/display-names adları çözer; dizi olmayan gövde 400', async () => {
      const missing = randomUUID();
      const response = await call('POST', '/users/display-names', clinicToken, {
        userIds: [owner.id, missing],
      });
      expect(response.status).toBe(200);
      expect(parse<users.GetUserDisplayNamesResponse>(response).data).toEqual({
        users: [
          {
            userId: owner.id,
            fullName: 'Ayşe Kaya',
            role: users.UserRole.PET_OWNER,
          },
        ],
        notFoundIds: [missing],
      });

      const bad = await call('POST', '/users/display-names', clinicToken, {
        userIds: owner.id,
      });
      expect(bad.status).toBe(400);
      expect(parse(bad).message).toBe('USER_IDS_MUST_BE_ARRAY');
    });

    it('POST /users/me/deactivate hesabı pasifleştirir', async () => {
      const response = await call('POST', '/users/me/deactivate', leaverToken);
      expect(response.status).toBe(200);
      expect(parse<users.UserResponse>(response).data?.user).toMatchObject({
        userId: leaver.id,
        isActive: false,
      });
    });

    it('POST /pets 201 CREATED ile hayvanı kaydeder; CLINIC rolü 403', async () => {
      const body = {
        name: 'Boncuk',
        species: 'DOG',
        breed: 'KANGAL',
        sex: pets.PetSex.MALE,
        birthDate: '2022-05-10',
        isBirthDateEstimated: false,
        isNeutered: true,
        chipNumber: '',
        ownerUserId: owner.id,
      };
      const response = await call('POST', '/pets', ownerToken, body);
      expect(response.status).toBe(201);
      const envelope = parse<pets.PetResponse>(response);
      expect(envelope).toMatchObject({
        message: 'CREATED',
        success: true,
        data: { pet: { name: 'Boncuk', ownerUserId: owner.id } },
      });
      petId = envelope.data?.pet?.id ?? '';
      data.trackPet(petId);

      expect((await call('POST', '/pets', clinicToken, body)).status).toBe(403);
    });

    it('GET /pets sahibin hayvanlarını, GET /pets/:id tek hayvanı döner; bozuk id 400', async () => {
      const list = parse<pets.ListMyPetsResponse>(
        await call('GET', '/pets', ownerToken),
      );
      expect(list.data?.pets.map((pet) => pet.id)).toEqual([petId]);

      const single = await call('GET', `/pets/${petId}`, ownerToken);
      expect(single.status).toBe(200);
      expect(parse<pets.PetResponse>(single).data?.pet?.id).toBe(petId);

      const bad = await call('GET', '/pets/abc', ownerToken);
      expect(bad.status).toBe(400);
      expect(parse(bad).message).toBe('PET_ID_WRONG DATA FORMAT');
    });

    it('PATCH /pets/:id yoldaki hayvanı günceller; gövdedeki id yok sayılır', async () => {
      const response = await call('PATCH', `/pets/${petId}`, ownerToken, {
        id: randomUUID(),
        name: 'Boncuk Yeni',
      });
      expect(response.status).toBe(200);
      expect(parse<pets.PetResponse>(response).data?.pet).toMatchObject({
        id: petId,
        name: 'Boncuk Yeni',
      });
    });

    // ---Amaç: RequestWithParams('body') kullanan uçta da 50 seviyeyi aşan gövdenin 500 yerine 400 ve Türkçe mesajla reddedildiğini doğrulamak ---
    it('PATCH /pets/:id 50 seviyeyi aşan gövdeyi 400 ile reddeder; 50 seviyeye izin verir', async () => {
      const nested = (levels: number): unknown => {
        let value: unknown = 1;
        for (let i = 0; i < levels; i++) value = { a: value };
        return value;
      };

      const tooDeep = await call('PATCH', `/pets/${petId}`, ownerToken, {
        name: 'Boncuk Yeni',
        extra: nested(50),
      });
      expect(tooDeep.status).toBe(400);
      expect(parse(tooDeep).message).toBe(
        'İstek gövdesi çok karmaşık (maksimum derinlik sınırı aşıldı).',
      );

      const allowed = await call('PATCH', `/pets/${petId}`, ownerToken, {
        name: 'Boncuk Yeni',
        extra: nested(49),
      });
      expect(allowed.status).toBe(200);
      expect(parse<pets.PetResponse>(allowed).data?.pet?.name).toBe(
        'Boncuk Yeni',
      );
    });

    it('GET /pets/search rızalı klinikte sonuç verir; PET_OWNER 403', async () => {
      const granted = await call('POST', '/consents', ownerToken, {
        clinicId: clinic.id,
        petId,
        scopes: ['medical_read', 'owner_contact_read'],
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
      expect(granted.status).toBe(200);

      const search = await call(
        'GET',
        '/pets/search?name=bon&page=1&pageSize=8',
        clinicToken,
      );
      expect(search.status).toBe(200);
      const envelope = parse<pets.SearchClinicPetsResponse>(search);
      expect(envelope.data?.total).toBe(1);
      expect(envelope.data?.pets[0].id).toBe(petId);

      expect(
        (await call('GET', '/pets/search?page=1&pageSize=8', ownerToken))
          .status,
      ).toBe(403);
    });

    it('GET /clinics/:id kendi kliniğine tam, hasta sahibine son 4 haneli vergi numarası döner', async () => {
      const own = parse<clinics.ClinicResponse>(
        await call('GET', `/clinics/${clinic.id}`, clinicToken),
      );
      expect(own).toMatchObject({
        success: true,
        data: { clinic: { id: clinic.id, taxNumber: clinic.taxNumber } },
      });
      const asOwner = parse<clinics.ClinicResponse>(
        await call('GET', `/clinics/${clinic.id}`, ownerToken),
      );
      expect(asOwner.data?.clinic?.taxNumber).toBe(clinic.taxNumber.slice(-4));
    });

    it('POST /clinics/:clinicId/stock-items 201 CREATED; fiyatlar kuruş olarak döner, fiyatsız istek 400; yoldaki klinik esas alınır; başka kliniğin yolu 403', async () => {
      const response = await call(
        'POST',
        `/clinics/${clinic.id}/stock-items`,
        clinicToken,
        {
          clinicId: otherClinic.id,
          name: 'Bandaj',
          category: 'SUPPLY',
          unit: 'PIECE',
          quantity: 1,
          criticalLevel: 5,
          expiresAt: '',
          purchasePrice: 1_250,
          salePrice: 2_000,
        },
      );
      expect(response.status).toBe(201);
      expect(parse<clinics.StockItemResponse>(response)).toMatchObject({
        message: 'CREATED',
        data: {
          item: {
            clinicId: clinic.id,
            isBelowCritical: true,
            purchasePrice: 1_250,
            salePrice: 2_000,
          },
        },
      });

      const noPrice = await call(
        'POST',
        `/clinics/${clinic.id}/stock-items`,
        clinicToken,
        {
          name: 'Bandaj',
          category: 'SUPPLY',
          unit: 'PIECE',
          quantity: 1,
          criticalLevel: 5,
          expiresAt: '',
          purchasePrice: '',
          salePrice: 2_000,
        },
      );
      expect(noPrice.status).toBe(400);
      expect(parse(noPrice).message).toBe('PURCHASE_PRICE_MUST_BE_NUMBER');

      const foreign = await call(
        'POST',
        `/clinics/${otherClinic.id}/stock-items`,
        clinicToken,
        {
          name: 'Bandaj',
          category: 'SUPPLY',
          unit: 'PIECE',
          quantity: 1,
          criticalLevel: 0,
          expiresAt: '',
          purchasePrice: 1_250,
          salePrice: 2_000,
        },
      );
      expect(foreign.status).toBe(403);
    });

    it('GET /clinics/:clinicId/stock-items sorgudaki onlyBelowCritical=true ile filtreler; geçersiz değerler 400', async () => {
      const filtered = await call(
        'GET',
        `/clinics/${clinic.id}/stock-items?onlyBelowCritical=true&page=1&pageSize=8`,
        clinicToken,
      );
      expect(filtered.status).toBe(200);
      const envelope = parse<clinics.ListStockItemsResponse>(filtered);
      expect(envelope.data?.total).toBe(1);
      expect(envelope.data?.items[0]).toMatchObject({
        name: 'Bandaj',
        isBelowCritical: true,
      });

      const badFlag = await call(
        'GET',
        `/clinics/${clinic.id}/stock-items?onlyBelowCritical=evet&page=1&pageSize=8`,
        clinicToken,
      );
      expect(badFlag.status).toBe(400);
      expect(parse(badFlag).message).toBe(
        'ONLY_BELOW_CRITICAL_MUST_BE_BOOLEAN',
      );

      const badPageSize = await call(
        'GET',
        `/clinics/${clinic.id}/stock-items?page=1&pageSize=10`,
        clinicToken,
      );
      expect(badPageSize.status).toBe(400);

      const foreign = await call(
        'GET',
        `/clinics/${clinic.id}/stock-items?page=1&pageSize=8`,
        otherClinicToken,
      );
      expect(foreign.status).toBe(403);
      expect(parse(foreign).message).toBe('FORBIDDEN');
    });

    const createStockItem = async (override: object = {}) => {
      const response = await call(
        'POST',
        `/clinics/${clinic.id}/stock-items`,
        clinicToken,
        {
          name: 'Kuduz Aşısı',
          category: 'VACCINE',
          unit: 'DOSE',
          quantity: 5,
          criticalLevel: 3,
          expiresAt: shiftDays(istanbulToday(), 30),
          purchasePrice: 8_000,
          salePrice: 12_000,
          ...override,
        },
      );
      expect(response.status).toBe(201);
      return parse<clinics.StockItemResponse>(response).data?.item?.id ?? '';
    };

    // ---Amaç: stok güncellemesinin yalnızca gönderilen alanları değiştirdiğini, fiyatların güncellenebildiğini, yoldaki kimliklerin esas alındığını, null tarihin kaldırıldığını ve sahiplik kurallarını doğrulamak ---
    it('PATCH /clinics/:clinicId/stock-items/:itemId yalnızca gönderilen alanları günceller; boş gövde 400; başka klinik 403/404', async () => {
      const itemId = await createStockItem();
      const path = `/clinics/${clinic.id}/stock-items/${itemId}`;

      const updated = await call('PATCH', path, clinicToken, {
        name: 'Kuduz Aşısı (Nobivac)',
        criticalLevel: 12,
        category: 'FOOD',
        clinicId: otherClinic.id,
        itemId: randomUUID(),
      });
      expect(updated.status).toBe(200);
      expect(parse<clinics.StockItemResponse>(updated)).toMatchObject({
        message: 'SUCCESS',
        success: true,
        data: {
          item: {
            id: itemId,
            clinicId: clinic.id,
            name: 'Kuduz Aşısı (Nobivac)',
            category: 'VACCINE',
            unit: 'DOSE',
            quantity: 5,
            criticalLevel: 12,
            isBelowCritical: true,
          },
        },
      });

      const cleared = await call('PATCH', path, clinicToken, {
        expiresAt: null,
      });
      expect(cleared.status).toBe(200);
      expect(
        parse<clinics.StockItemResponse>(cleared).data?.item?.expiresAt,
      ).toBe('');

      const repriced = await call('PATCH', path, clinicToken, {
        purchasePrice: 9_000,
        salePrice: 15_000,
      });
      expect(repriced.status).toBe(200);
      expect(
        parse<clinics.StockItemResponse>(repriced).data?.item,
      ).toMatchObject({
        name: 'Kuduz Aşısı (Nobivac)',
        purchasePrice: 9_000,
        salePrice: 15_000,
      });

      const nullPrice = await call('PATCH', path, clinicToken, {
        salePrice: null,
      });
      expect(nullPrice.status).toBe(400);
      expect(parse(nullPrice).message).toBe('SALE_PRICE_MUST_BE_NUMBER');

      const emptyPrice = await call('PATCH', path, clinicToken, {
        purchasePrice: '',
      });
      expect(emptyPrice.status).toBe(400);
      expect(parse(emptyPrice).message).toBe('PURCHASE_PRICE_MUST_BE_NUMBER');
      const kept = parse<clinics.ListStockItemsResponse>(
        await call(
          'GET',
          `/clinics/${clinic.id}/stock-items?page=1&pageSize=64`,
          clinicToken,
        ),
      ).data?.items.find((item) => item.id === itemId);
      expect(kept).toMatchObject({ purchasePrice: 9_000, salePrice: 15_000 });

      const empty = await call('PATCH', path, clinicToken, {});
      expect(empty.status).toBe(400);
      expect(parse(empty).message).toBe('BAD_REQUEST');

      const past = await call('PATCH', path, clinicToken, {
        expiresAt: shiftDays(istanbulToday(), -1),
      });
      expect(past.status).toBe(400);
      expect(parse(past).message).toBe('EXPIRES_AT_CANNOT_BE_PAST');

      const badId = await call(
        'PATCH',
        `/clinics/${clinic.id}/stock-items/abc`,
        clinicToken,
        { quantity: 1 },
      );
      expect(badId.status).toBe(400);
      expect(parse(badId).message).toBe('STOCK_ITEM_ID_WRONG DATA FORMAT');

      const foreignPath = await call(
        'PATCH',
        `/clinics/${otherClinic.id}/stock-items/${itemId}`,
        clinicToken,
        { quantity: 1 },
      );
      expect(foreignPath.status).toBe(403);

      const foreignItem = await call(
        'PATCH',
        `/clinics/${otherClinic.id}/stock-items/${itemId}`,
        otherClinicToken,
        { quantity: 1 },
      );
      expect(foreignItem.status).toBe(404);
      expect(parse(foreignItem).message).toBe('NOT_FOUND');
    });

    // ---Amaç: artış ve azalışın atomik uygulandığını, sınır dışına çıkaran isteğin stoku değiştirmeden reddedildiğini ve eşzamanlı azalışların miktarı eksiye düşüremediğini doğrulamak ---
    it('POST /clinics/:clinicId/stock-items/:itemId/adjust sınırları korur ve eşzamanlı isteklerde atomiktir', async () => {
      const itemId = await createStockItem({ quantity: 5 });
      const path = `/clinics/${clinic.id}/stock-items/${itemId}/adjust`;
      const adjust = (delta: unknown, token = clinicToken, url = path) =>
        call('POST', url, token, { delta });
      const quantityOf = (response: HttpResponse) =>
        parse<clinics.StockItemResponse>(response).data?.item?.quantity;

      const decreased = await adjust(-2);
      expect(decreased.status).toBe(200);
      expect(parse(decreased).message).toBe('SUCCESS');
      expect(quantityOf(decreased)).toBe(3);

      const tooLow = await adjust(-4);
      expect(tooLow.status).toBe(400);
      expect(parse(tooLow).message).toBe('QUANTITY_MIN|0');

      const results = await Promise.all(
        Array.from({ length: 5 }, () => adjust(-1)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(
        results
          .filter((r) => r.status !== 200)
          .map((r) => [r.status, parse(r).message]),
      ).toEqual([
        [400, 'QUANTITY_MIN|0'],
        [400, 'QUANTITY_MIN|0'],
      ]);

      const filled = await adjust(100_000);
      expect(quantityOf(filled)).toBe(100_000);
      const tooHigh = await adjust(1);
      expect(tooHigh.status).toBe(400);
      expect(parse(tooHigh).message).toBe('QUANTITY_MAX|100000');

      for (const [delta, message] of [
        [0, 'DELTA_NOT_VALID'],
        ['beş', 'DELTA_MUST_BE_NUMBER'],
        [100_001, 'DELTA_MAX|100000'],
      ] as const) {
        const invalid = await adjust(delta);
        expect(invalid.status).toBe(400);
        expect(parse(invalid).message).toBe(message);
      }

      expect(
        (
          await adjust(
            -1,
            clinicToken,
            `/clinics/${otherClinic.id}/stock-items/${itemId}/adjust`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await adjust(
            -1,
            otherClinicToken,
            `/clinics/${otherClinic.id}/stock-items/${itemId}/adjust`,
          )
        ).status,
      ).toBe(404);
      expect(quantityOf(await adjust(-100_000))).toBe(0);
    });

    // ---Amaç: stok kaleminin kalıcı silindiğini, yanıtta silinen kalemin döndüğünü, tekrar silmenin 404 verdiğini ve sahiplik kurallarını doğrulamak ---
    it('DELETE /clinics/:clinicId/stock-items/:itemId kalemi kalıcı siler ve silinen kalemi döner', async () => {
      const itemId = await createStockItem({ name: 'Silinecek Kalem' });
      const path = `/clinics/${clinic.id}/stock-items/${itemId}`;

      expect(
        (
          await call(
            'DELETE',
            `/clinics/${otherClinic.id}/stock-items/${itemId}`,
            otherClinicToken,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call(
            'DELETE',
            `/clinics/${otherClinic.id}/stock-items/${itemId}`,
            clinicToken,
          )
        ).status,
      ).toBe(403);

      const deleted = await call('DELETE', path, clinicToken);
      expect(deleted.status).toBe(200);
      expect(parse<clinics.StockItemResponse>(deleted)).toMatchObject({
        message: 'SUCCESS',
        success: true,
        data: { item: { id: itemId, name: 'Silinecek Kalem' } },
      });

      const list = parse<clinics.ListStockItemsResponse>(
        await call(
          'GET',
          `/clinics/${clinic.id}/stock-items?page=1&pageSize=64`,
          clinicToken,
        ),
      );
      expect(list.data?.items.map((item) => item.id)).not.toContain(itemId);

      const again = await call('DELETE', path, clinicToken);
      expect(again.status).toBe(404);
      expect(parse(again).message).toBe('NOT_FOUND');
    });

    // ---Amaç: satış, iptal, satış listesi ve aylık rapor uçlarını gerçek veritabanında, İstanbul gün/hafta/ay sınırlarıyla uçtan uca doğrulamak ---
    describe('stok satışları', () => {
      let salesClinic: SeededClinic;
      let salesToken: string;

      const salesUrl = (suffix: string, clinicId = salesClinic.id) =>
        `/clinics/${clinicId}${suffix}`;

      const addItem = async (override: object = {}) => {
        const response = await call(
          'POST',
          salesUrl('/stock-items'),
          salesToken,
          {
            name: 'Amoksisilin Tablet',
            category: 'MEDICINE',
            unit: 'BOX',
            quantity: 50,
            criticalLevel: 0,
            expiresAt: '',
            purchasePrice: 8_000,
            salePrice: 12_000,
            ...override,
          },
        );
        expect(response.status).toBe(201);
        return parse<clinics.StockItemResponse>(response).data?.item?.id ?? '';
      };

      const sell = (
        itemId: string,
        body: object,
        token = salesToken,
        clinicId = salesClinic.id,
      ) =>
        call(
          'POST',
          salesUrl(`/stock-items/${itemId}/sales`, clinicId),
          token,
          body,
        );

      const sold = async (itemId: string, body: object) => {
        const response = await sell(itemId, body);
        expect(response.status).toBe(201);
        const envelope = parse<clinics.StockSaleResponse>(response);
        expect(envelope.message).toBe('CREATED');
        return {
          sale: envelope.data?.sale as clinics.StockSale,
          item: envelope.data?.item,
        };
      };

      const cancel = (
        saleId: string,
        token = salesToken,
        clinicId = salesClinic.id,
      ) =>
        call(
          'POST',
          salesUrl(`/stock-sales/${saleId}/cancel`, clinicId),
          token,
        );

      const summary = async (query = '') => {
        const response = await call(
          'GET',
          salesUrl(`/stock-sales/summary${query}`),
          salesToken,
        );
        expect(response.status).toBe(200);
        return parse<clinics.StockSalesSummaryResponse>(response)
          .data as clinics.StockSalesSummaryResponse;
      };

      const listSales = async (query: string) => {
        const response = await call(
          'GET',
          salesUrl(`/stock-sales?${query}`),
          salesToken,
        );
        expect(response.status).toBe(200);
        return parse<clinics.ListStockSalesResponse>(response)
          .data as clinics.ListStockSalesResponse;
      };

      const stockOf = async (itemId: string) => {
        const db = await data.db('clinics');
        const { rows } = await db.query<{ quantity: number }>(
          'SELECT quantity FROM stock_items WHERE id = $1',
          [itemId],
        );
        return rows[0]?.quantity;
      };

      const moveSale = async (saleId: string, istanbulTime: string) => {
        const db = await data.db('clinics');
        await db.query(
          "UPDATE stock_sales SET sold_at = ($2::timestamptz AT TIME ZONE 'UTC') WHERE id = $1",
          [saleId, new Date(istanbulTime).toISOString()],
        );
      };

      const figures = (
        revenue: number,
        cost: number,
        salesCount: number,
        quantity: number,
      ) => ({ revenue, cost, profit: revenue - cost, salesCount, quantity });

      beforeAll(async () => {
        salesClinic = await data.insertClinic({ name: 'Satış Test Kliniği' });
        salesToken = await opaqueTokenFor(
          'CLINIC',
          randomUUID(),
          salesClinic.id,
        );
      });

      it('POST /clinics/:clinicId/stock-items/:itemId/sales stoku düşer, satış anındaki ad, birim ve fiyatları saklar; sonraki fiyat değişikliği eski satışı değiştirmez', async () => {
        const itemId = await addItem({ quantity: 10 });

        const first = await sold(itemId, { quantity: 3 });
        expect(first.sale).toMatchObject({
          clinicId: salesClinic.id,
          stockItemId: itemId,
          itemName: 'Amoksisilin Tablet',
          category: 'MEDICINE',
          unit: 'BOX',
          quantity: 3,
          unitSalePrice: 12_000,
          unitPurchasePrice: 8_000,
          totalSale: 36_000,
          totalCost: 24_000,
          profit: 12_000,
          cancelledAt: '',
        });
        expect(first.sale.id).toMatch(UUID_V4);
        expect(Number.isNaN(Date.parse(first.sale.soldAt))).toBe(false);
        expect(first.item?.quantity).toBe(7);

        const repriced = await call(
          'PATCH',
          salesUrl(`/stock-items/${itemId}`),
          salesToken,
          { name: 'Amoksisilin 500', purchasePrice: 9_000, salePrice: 15_000 },
        );
        expect(repriced.status).toBe(200);

        const discounted = await sold(itemId, {
          quantity: 2,
          unitPrice: 14_000,
        });
        expect(discounted.sale).toMatchObject({
          itemName: 'Amoksisilin 500',
          unitSalePrice: 14_000,
          unitPurchasePrice: 9_000,
          totalSale: 28_000,
          totalCost: 18_000,
          profit: 10_000,
        });
        const regular = await sold(itemId, { quantity: 1 });
        expect(regular.sale).toMatchObject({
          unitSalePrice: 15_000,
          unitPurchasePrice: 9_000,
          profit: 6_000,
        });
        expect(regular.item?.quantity).toBe(4);

        const own = (await listSales('page=1&pageSize=8')).sales.filter(
          (sale) => sale.stockItemId === itemId,
        );
        expect(own.map((sale) => sale.id)).toEqual([
          regular.sale.id,
          discounted.sale.id,
          first.sale.id,
        ]);
        expect(own[2]).toEqual(first.sale);
      });

      it('stok yetersizliği, fiyatsız eski kalem, geçersiz gövde ve yetki kuralları; eşzamanlı satışlar stoku eksiye düşüremez', async () => {
        const itemId = await addItem({
          name: 'Kuduz Aşısı',
          category: 'VACCINE',
          unit: 'DOSE',
          quantity: 5,
        });
        const db = await data.db('clinics');

        const results = await Promise.all(
          Array.from({ length: 8 }, () => sell(itemId, { quantity: 1 })),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(5);
        expect(
          results
            .filter((r) => r.status !== 201)
            .map((r) => [r.status, parse(r).message]),
        ).toEqual([
          [400, 'QUANTITY_MIN|0'],
          [400, 'QUANTITY_MIN|0'],
          [400, 'QUANTITY_MIN|0'],
        ]);
        expect(await stockOf(itemId)).toBe(0);
        const { rows } = await db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM stock_sales WHERE stock_item_id = $1',
          [itemId],
        );
        expect(rows[0].n).toBe(5);

        for (const [body, message] of [
          [{ quantity: 0 }, 'QUANTITY_MIN|1'],
          [{ quantity: 100_001 }, 'QUANTITY_MAX|100000'],
          [{}, 'QUANTITY_MUST_BE_NUMBER'],
          [{ quantity: 1, unitPrice: -1 }, 'UNIT_PRICE_MIN|0'],
          [{ quantity: 1, unitPrice: 149.9 }, 'UNIT_PRICE_MUST_BE_NUMBER'],
        ] as const) {
          const invalid = await sell(itemId, body);
          expect([invalid.status, parse(invalid).message]).toEqual([
            400,
            message,
          ]);
        }

        const badId = await sell('abc', { quantity: 1 });
        expect([badId.status, parse(badId).message]).toEqual([
          400,
          'STOCK_ITEM_ID_WRONG DATA FORMAT',
        ]);
        const unknown = await sell(randomUUID(), { quantity: 1 });
        expect([unknown.status, parse(unknown).message]).toEqual([
          404,
          'NOT_FOUND',
        ]);
        expect(
          (await sell(itemId, { quantity: 1 }, otherClinicToken)).status,
        ).toBe(403);
        expect(
          (
            await sell(
              itemId,
              { quantity: 1 },
              otherClinicToken,
              otherClinic.id,
            )
          ).status,
        ).toBe(404);
        expect((await sell(itemId, { quantity: 1 }, ownerToken)).status).toBe(
          403,
        );

        const legacyId = randomUUID();
        await db.query(
          "INSERT INTO stock_items (id, clinic_id, name, category, unit, quantity, critical_level, created_by, updated_at) VALUES ($1, $2, 'Eski Kalem', 'SUPPLY', 'PIECE', 10, 0, $3, now())",
          [legacyId, salesClinic.id, randomUUID()],
        );
        const reprice = (body: object) =>
          call('PATCH', salesUrl(`/stock-items/${legacyId}`), salesToken, body);

        const noPurchasePrice = await sell(legacyId, { quantity: 1 });
        expect([
          noPurchasePrice.status,
          parse(noPurchasePrice).message,
        ]).toEqual([400, 'PURCHASE_PRICE_NOT_EMPTY']);
        expect((await reprice({ purchasePrice: 1_000 })).status).toBe(200);
        const noSalePrice = await sell(legacyId, { quantity: 1 });
        expect([noSalePrice.status, parse(noSalePrice).message]).toEqual([
          400,
          'SALE_PRICE_NOT_EMPTY',
        ]);
        expect((await reprice({ salePrice: 1_500 })).status).toBe(200);
        const priced = await sold(legacyId, { quantity: 2 });
        expect(priced.sale).toMatchObject({
          totalSale: 3_000,
          totalCost: 2_000,
          profit: 1_000,
        });
        expect(await stockOf(legacyId)).toBe(8);
      });

      it('POST /clinics/:clinicId/stock-sales/:saleId/cancel stoku geri ekler ve satışı rapordan çıkarır; ikinci iptal ve önceki ay satışı 409; kalemi silinmiş satış iptal edilebilir', async () => {
        const itemId = await addItem({
          name: 'Gazlı Bez',
          category: 'SUPPLY',
          unit: 'PIECE',
          quantity: 10,
          purchasePrice: 500,
          salePrice: 1_000,
        });
        const db = await data.db('clinics');
        const today = istanbulToday();
        const dayRevenue = (report: clinics.StockSalesSummaryResponse) =>
          report.daily.find((day) => day.date === today)?.revenue ?? 0;

        const before = await summary();
        const totals = before.totals as clinics.SalesTotals;
        expect(before.month).toBe(today.slice(0, 7));

        const { sale } = await sold(itemId, { quantity: 4 });
        const during = await summary();
        expect(during.totals).toEqual({
          revenue: totals.revenue + 4_000,
          cost: totals.cost + 2_000,
          profit: totals.profit + 2_000,
          salesCount: totals.salesCount + 1,
          quantity: totals.quantity + 4,
        });
        expect(dayRevenue(during)).toBe(dayRevenue(before) + 4_000);

        const cancelled = await cancel(sale.id);
        expect(cancelled.status).toBe(200);
        const envelope = parse<clinics.StockSaleResponse>(cancelled);
        expect(envelope.message).toBe('SUCCESS');
        expect(envelope.data?.sale?.cancelledAt).not.toBe('');
        expect(envelope.data?.item?.quantity).toBe(10);
        expect((await summary()).totals).toEqual(totals);

        const again = await cancel(sale.id);
        expect([again.status, parse(again).message]).toEqual([409, 'CONFLICT']);
        const listed = (await listSales('page=1&pageSize=128')).sales.find(
          (row) => row.id === sale.id,
        );
        expect(listed?.cancelledAt).toBe(envelope.data?.sale?.cancelledAt);

        const old = await sold(itemId, { quantity: 1 });
        await db.query(
          "UPDATE stock_sales SET sold_at = sold_at - interval '40 days' WHERE id = $1",
          [old.sale.id],
        );
        const lastMonth = await cancel(old.sale.id);
        expect([lastMonth.status, parse(lastMonth).message]).toEqual([
          409,
          'CONFLICT',
        ]);
        expect(await stockOf(itemId)).toBe(9);

        const removedId = await addItem({
          name: 'Silinecek Ürün',
          quantity: 3,
        });
        const orphan = await sold(removedId, { quantity: 2 });
        expect(
          (
            await call(
              'DELETE',
              salesUrl(`/stock-items/${removedId}`),
              salesToken,
            )
          ).status,
        ).toBe(200);
        const orphanCancel = await cancel(orphan.sale.id);
        expect(orphanCancel.status).toBe(200);
        expect(
          parse<clinics.StockSaleResponse>(orphanCancel).data,
        ).toMatchObject({
          sale: {
            id: orphan.sale.id,
            stockItemId: '',
            itemName: 'Silinecek Ürün',
          },
          item: null,
        });

        const fullId = await addItem({ name: 'Dolu Raf', quantity: 10 });
        const full = await sold(fullId, { quantity: 5 });
        const filled = await call(
          'POST',
          salesUrl(`/stock-items/${fullId}/adjust`),
          salesToken,
          { delta: 99_995 },
        );
        expect(
          parse<clinics.StockItemResponse>(filled).data?.item?.quantity,
        ).toBe(100_000);
        const overflow = await cancel(full.sale.id);
        expect([overflow.status, parse(overflow).message]).toEqual([
          400,
          'QUANTITY_MAX|100000',
        ]);
        const { rows } = await db.query(
          'SELECT cancelled_at FROM stock_sales WHERE id = $1',
          [full.sale.id],
        );
        expect(rows[0].cancelled_at).toBeNull();
        expect(await stockOf(fullId)).toBe(100_000);

        expect((await cancel(old.sale.id, otherClinicToken)).status).toBe(403);
        expect(
          (await cancel(old.sale.id, otherClinicToken, otherClinic.id)).status,
        ).toBe(404);
        const badId = await cancel('abc');
        expect([badId.status, parse(badId).message]).toEqual([
          400,
          'SALE_ID_WRONG DATA FORMAT',
        ]);
        expect((await cancel(randomUUID())).status).toBe(404);
      });

      it('GET /clinics/:clinicId/stock-sales/summary ayı İstanbul gün ve hafta sınırlarıyla hesaplar, iptalleri dışlar, silinen kalemin satışlarını korur; liste tarih filtresi aynı sınırları kullanır', async () => {
        const amoxicillin = await addItem();
        const food = await addItem({
          name: 'Kedi Maması',
          category: 'FOOD',
          unit: 'PIECE',
          purchasePrice: 5_000,
          salePrice: 9_000,
        });
        const place = async (
          itemId: string,
          body: object,
          istanbulTime: string,
        ) => {
          const { sale } = await sold(itemId, body);
          await moveSale(sale.id, istanbulTime);
          return sale.id;
        };

        const juneFirst = await place(
          amoxicillin,
          { quantity: 3 },
          '2026-06-01T00:30:00+03:00',
        );
        const juneSunday = await place(
          food,
          { quantity: 2, unitPrice: 7_000 },
          '2026-06-07T23:59:00+03:00',
        );
        const juneMonday = await place(
          amoxicillin,
          { quantity: 1, unitPrice: 6_000 },
          '2026-06-08T00:00:00+03:00',
        );
        const juneLast = await place(
          food,
          { quantity: 4 },
          '2026-06-30T23:59:59+03:00',
        );
        const julyFirst = await place(
          amoxicillin,
          { quantity: 2 },
          '2026-07-01T00:00:00+03:00',
        );
        const mayLast = await place(
          food,
          { quantity: 1 },
          '2026-05-31T23:59:59+03:00',
        );
        const cancelledSale = (await sold(amoxicillin, { quantity: 5 })).sale
          .id;
        expect((await cancel(cancelledSale)).status).toBe(200);
        await moveSale(cancelledSale, '2026-06-15T12:00:00+03:00');
        expect(
          (await call('DELETE', salesUrl(`/stock-items/${food}`), salesToken))
            .status,
        ).toBe(200);

        const june = await summary('?month=2026-06');
        expect(june.month).toBe('2026-06');
        expect(june.totals).toEqual(figures(92_000, 62_000, 4, 10));
        expect(june.daily).toHaveLength(30);
        expect(june.daily.filter((day) => day.salesCount > 0)).toEqual([
          { date: '2026-06-01', ...figures(36_000, 24_000, 1, 3) },
          { date: '2026-06-07', ...figures(14_000, 10_000, 1, 2) },
          { date: '2026-06-08', ...figures(6_000, 8_000, 1, 1) },
          { date: '2026-06-30', ...figures(36_000, 20_000, 1, 4) },
        ]);
        expect(june.weekly).toEqual([
          {
            weekStart: '2026-06-01',
            weekEnd: '2026-06-07',
            ...figures(50_000, 34_000, 2, 5),
          },
          {
            weekStart: '2026-06-08',
            weekEnd: '2026-06-14',
            ...figures(6_000, 8_000, 1, 1),
          },
          {
            weekStart: '2026-06-15',
            weekEnd: '2026-06-21',
            ...figures(0, 0, 0, 0),
          },
          {
            weekStart: '2026-06-22',
            weekEnd: '2026-06-28',
            ...figures(0, 0, 0, 0),
          },
          {
            weekStart: '2026-06-29',
            weekEnd: '2026-06-30',
            ...figures(36_000, 20_000, 1, 4),
          },
        ]);
        expect(june.products).toEqual([
          {
            stockItemId: '',
            itemName: 'Kedi Maması',
            unit: 'PIECE',
            ...figures(50_000, 30_000, 2, 6),
          },
          {
            stockItemId: amoxicillin,
            itemName: 'Amoksisilin Tablet',
            unit: 'BOX',
            ...figures(42_000, 32_000, 2, 4),
          },
        ]);

        const july = await summary('?month=2026-07');
        expect(july.totals).toEqual(figures(24_000, 16_000, 1, 2));
        expect(july.daily[0]).toEqual({
          date: '2026-07-01',
          ...figures(24_000, 16_000, 1, 2),
        });
        expect(july.products.map((product) => product.stockItemId)).toEqual([
          amoxicillin,
        ]);

        const may = await summary('?month=2026-05');
        expect(may.totals).toEqual(figures(9_000, 5_000, 1, 1));
        expect(may.daily[30]).toEqual({
          date: '2026-05-31',
          ...figures(9_000, 5_000, 1, 1),
        });
        expect(may.products).toEqual([
          {
            stockItemId: '',
            itemName: 'Kedi Maması',
            unit: 'PIECE',
            ...figures(9_000, 5_000, 1, 1),
          },
        ]);

        const future = await summary('?month=2027-02');
        expect(future.totals).toEqual(figures(0, 0, 0, 0));
        expect(future.daily).toHaveLength(28);
        expect(
          future.weekly.map((week) => [week.weekStart, week.weekEnd]),
        ).toEqual([
          ['2027-02-01', '2027-02-07'],
          ['2027-02-08', '2027-02-14'],
          ['2027-02-15', '2027-02-21'],
          ['2027-02-22', '2027-02-28'],
        ]);

        const invalidMonth = await call(
          'GET',
          salesUrl('/stock-sales/summary?month=2026-13'),
          salesToken,
        );
        expect([invalidMonth.status, parse(invalidMonth).message]).toEqual([
          400,
          'MONTH_WRONG DATA FORMAT',
        ]);
        expect(
          (
            await call(
              'GET',
              salesUrl('/stock-sales/summary'),
              otherClinicToken,
            )
          ).status,
        ).toBe(403);

        const idsOf = async (query: string) =>
          (await listSales(`${query}&page=1&pageSize=8`)).sales.map(
            (row) => row.id,
          );
        expect(await idsOf('fromDate=2026-06-01&toDate=2026-06-07')).toEqual([
          juneSunday,
          juneFirst,
        ]);
        expect(await idsOf('fromDate=2026-06-08&toDate=2026-06-30')).toEqual([
          juneLast,
          cancelledSale,
          juneMonday,
        ]);
        expect(await idsOf('fromDate=2026-07-01&toDate=2026-07-01')).toEqual([
          julyFirst,
        ]);
        expect(await idsOf('toDate=2026-05-31')).toEqual([mayLast]);
        const secondPage = await listSales(
          'fromDate=2026-06-01&toDate=2026-06-30&page=2&pageSize=8',
        );
        expect([secondPage.sales, secondPage.total]).toEqual([[], 5]);
        const badRange = await call(
          'GET',
          salesUrl(
            '/stock-sales?fromDate=2026-06-08&toDate=2026-06-07&page=1&pageSize=8',
          ),
          salesToken,
        );
        expect([badRange.status, parse(badRange).message]).toEqual([
          400,
          'TO_DATE_NOT_VALID',
        ]);
      });
    });

    it('GET /clinics/:clinicId/pets/:petId/overview özeti ve rızalı sahip bilgisini döner', async () => {
      const response = await call(
        'GET',
        `/clinics/${clinic.id}/pets/${petId}/overview`,
        clinicToken,
      );
      expect(response.status).toBe(200);
      expect(
        parse<clinics.GetClinicPetOverviewResponse>(response).data,
      ).toMatchObject({
        pet: { petId, name: 'Boncuk Yeni', ownerUserId: owner.id },
        owner: { userId: owner.id, fullName: 'Ayşe Kaya', phone: owner.phone },
        unavailableSources: [],
      });
    });

    it('POST /clinics/:clinicId/deactivate kliniği pasifleştirir; başka klinik 403', async () => {
      expect(
        (
          await call(
            'POST',
            `/clinics/${closingClinic.id}/deactivate`,
            clinicToken,
          )
        ).status,
      ).toBe(403);

      const response = await call(
        'POST',
        `/clinics/${closingClinic.id}/deactivate`,
        closingClinicToken,
      );
      expect(response.status).toBe(200);
      const clinicData = parse<clinics.ClinicResponse>(response).data?.clinic;
      expect(clinicData?.isActive).toBe(false);
      expect(clinicData?.taxNumber).toMatch(/^X\d{10}$/);
    });

    it('servisler arası RPC’ler ve medical-record bekleyen yükleme dışarıya açık değildir', async () => {
      const closed: [string, string][] = [
        ['POST', '/users'],
        ['DELETE', `/users/${owner.id}`],
        ['GET', `/users/${owner.id}`],
        ['GET', `/users/${owner.id}/role`],
        ['GET', `/users/${owner.id}/auth-info`],
        ['GET', `/users/${owner.id}/contact?petId=${petId}`],
        ['POST', '/users/clinic-users'],
        ['POST', '/users/deactivate-clinic-users'],
        ['GET', `/pets/${petId}/owner`],
        ['POST', '/clinics'],
        ['POST', `/clinics/${clinic.id}/pets/${petId}/results`],
      ];
      for (const [method, path] of closed) {
        expect({
          route: `${method} ${path}`,
          status: (await call(method, path, ownerToken, {})).status,
        }).toEqual({ route: `${method} ${path}`, status: 404 });
      }
    });
  });

  // ---Amaç: belge yükleme ucunun dosya türü/boyut/rıza kurallarını, depoya etkisini ve tıbbi kayıt uçlarını doğrulamak ---
  describe('belge yükleme ve tıbbi kayıt uçları', () => {
    const data = new TestData({ medicalRecord: true });
    const store = new ObjectStore();
    const bus = new EventBus();
    const opaqueTokens: string[] = [];
    const today = istanbulToday();
    const MAX = 10 * 1024 * 1024;

    let accessClient: Client;
    let owner: SeededUser;
    let clinic: SeededClinic;
    let foreignClinic: SeededClinic;
    let ownerToken: string;
    let clinicToken: string;
    let foreignToken: string;
    let strangerToken: string;
    let petId: string;
    let documentId: string;

    const opaqueTokenFor = async (
      role: 'PET_OWNER' | 'CLINIC',
      userId: string,
      clinicId = '',
    ) => {
      const created = expectOk(
        await callGrpc<access.CreateTokenResponse>(
          accessClient,
          'CreateOpaqueToken',
          {
            userId,
            role,
            clinicId,
            clientType: access.ClientType.WEB,
            ttlSeconds: 0,
          },
        ),
        'access.CreateOpaqueToken',
      );
      opaqueTokens.push(created.opaqueToken);
      return created.opaqueToken;
    };

    const call = (
      method: string,
      path: string,
      token: string,
      body?: unknown,
    ) =>
      httpRequest(service.port, method, path, {
        headers: { authorization: `Bearer ${token}`, ...WEB },
        body,
      });

    const upload = (
      token: string | null,
      file?: { filename: string; contentType: string; content: Buffer },
      note?: string,
      clinicId = clinic.id,
    ) =>
      httpUpload(service.port, `/clinics/${clinicId}/pets/${petId}/documents`, {
        headers: token ? { authorization: `Bearer ${token}`, ...WEB } : WEB,
        fields: note === undefined ? {} : { note },
        file: file && { field: 'file', ...file },
      });

    const documentOf = async (id: string) =>
      (
        await (
          await data.db('medical_record')
        ).query<{
          storage_path: string;
          original_name: string;
          mime_type: string;
          size_bytes: number;
          sha256: string;
          note: string | null;
        }>(
          'SELECT storage_path, original_name, mime_type, size_bytes, sha256, note FROM documents WHERE id = $1',
          [id],
        )
      ).rows[0];

    beforeAll(async () => {
      accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
      owner = await data.insertUser({ fullName: 'Ayşe Yılmaz' });
      clinic = await data.insertClinic({ name: 'Yükleme Kliniği' });
      foreignClinic = await data.insertClinic({ name: 'Rızasız Klinik' });
      ownerToken = await opaqueTokenFor('PET_OWNER', owner.id);
      clinicToken = await opaqueTokenFor('CLINIC', randomUUID(), clinic.id);
      foreignToken = await opaqueTokenFor(
        'CLINIC',
        randomUUID(),
        foreignClinic.id,
      );
      const stranger = await data.insertUser({ fullName: 'Başka Sahip' });
      strangerToken = await opaqueTokenFor('PET_OWNER', stranger.id);

      const created = await call('POST', '/pets', ownerToken, {
        name: 'Pamuk',
        species: 'CAT',
        breed: 'TURKISH_VAN',
        sex: pets.PetSex.FEMALE,
        ownerUserId: owner.id,
      });
      petId = parse<pets.PetResponse>(created).data?.pet?.id ?? '';
      data.trackPet(petId);
      const granted = await call('POST', '/consents', ownerToken, {
        clinicId: clinic.id,
        petId,
        scopes: [
          'medical_read',
          'medical_write',
          'vaccination_read',
          'prescription_read',
        ],
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
      expect(granted.status).toBe(200);
    });

    afterAll(async () => {
      try {
        for (const opaqueToken of opaqueTokens) {
          await callGrpc(accessClient, 'RevokeToken', { opaqueToken });
        }
        await data.cleanup();
      } finally {
        await data.close();
        await bus.close();
        store.close();
        accessClient?.close();
      }
    });

    it('PDF yükleme 201 döner; Türkçe dosya adı, gerçek tür, sha256 ve kırpılmış not saklanır, dosya depoya yazılır', async () => {
      const pdf = samplePdf();
      const name = 'Kan Tahlili ğüşiöç İ.pdf';
      const response = await upload(
        clinicToken,
        { filename: name, contentType: 'application/pdf', content: pdf },
        '  Açlık kan şekeri  ',
      );
      expect(response.status).toBe(201);
      const body = parse<clinics.UploadPetResultResponse>(response);
      expect(body).toMatchObject({
        message: 'CREATED',
        data: { status: 'QUEUED' },
      });
      documentId = body.data?.documentId ?? '';

      const row = await documentOf(documentId);
      expect(row).toMatchObject({
        original_name: name,
        mime_type: 'application/pdf',
        size_bytes: pdf.length,
        sha256: createHash('sha256').update(pdf).digest('hex'),
        note: 'Açlık kan şekeri',
      });
      expect(row.storage_path).toMatch(/^[0-9a-f-]{36}\.pdf$/);
      expect(await store.head(row.storage_path)).toMatchObject({
        ContentLength: pdf.length,
        ContentType: 'application/pdf',
      });
    });

    it('içerik PNG ise istemcinin bildirdiği tür yerine image/png saklanır', async () => {
      const response = await upload(clinicToken, {
        filename: 'aslinda-png.pdf',
        contentType: 'application/pdf',
        content: samplePng(),
      });
      expect(response.status).toBe(201);
      const row = await documentOf(
        parse<clinics.UploadPetResultResponse>(response).data?.documentId ??
          '',
      );
      expect(row.mime_type).toBe('image/png');
      expect(row.storage_path.endsWith('.png')).toBe(true);
    });

    it.each([
      [
        'metin dosyası',
        {
          filename: 'not.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('düz metin'),
        },
        'MIME_TYPE_NOT_VALID',
      ],
      ['dosya yok', undefined, 'FILE_NOT_EMPTY'],
      [
        '10 MB + 1 bayt',
        {
          filename: 'buyuk.pdf',
          contentType: 'application/pdf',
          content: pdfOfSize(MAX + 1),
        },
        'SIZE_BYTES_MAX|10485760',
      ],
    ])('%s → 400 %s, depoya yazılmaz', async (_n, file, message) => {
      const before = await store.keyCount();
      const response = await upload(clinicToken, file);
      expect(response.status).toBe(400);
      expect(parse(response).message).toBe(message);
      expect(await store.keyCount()).toBe(before);
    });

    it('tam 10 MB kabul edilir', async () => {
      const response = await upload(clinicToken, {
        filename: 'tam10mb.pdf',
        contentType: 'application/pdf',
        content: pdfOfSize(MAX),
      });
      expect(response.status).toBe(201);
    });

    it('rızası olmayan klinik 403 alır ve yüklenen dosya depodan geri silinir; token yoksa 401', async () => {
      const before = await store.keyCount();
      const response = await upload(
        foreignToken,
        {
          filename: 'rizasiz.pdf',
          contentType: 'application/pdf',
          content: samplePdf(),
        },
        undefined,
        foreignClinic.id,
      );
      expect(response.status).toBe(403);
      expect(parse(response).message).toBe('FORBIDDEN');
      expect(await store.keyCount()).toBe(before);
      const anonymous = await upload(null, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
        content: samplePdf(),
      });
      expect(anonymous.status).toBe(401);
    });

    it('POST /pets/:petId/records 201 döner (sayısal enum, ek); listeler hasta sahibine ve rızalı kliniğe açıktır', async () => {
      const created = await call('POST', `/pets/${petId}/records`, clinicToken, {
        content: {
          type: medicalRecord.RecordType.VACCINATION,
          title: 'Kuduz aşısı',
          recordedAt: today,
          vaccination: {
            vaccineName: 'Kuduz',
            administeredAt: today,
            nextDueAt: shiftDays(today, 365),
          },
        },
        attachments: [{ documentId }],
      });
      expect(created.status).toBe(201);
      expect(
        parse<medicalRecord.RecordResponse>(created).data?.record,
      ).toMatchObject({
        type: medicalRecord.RecordType.VACCINATION,
        attachments: [expect.objectContaining({ documentId })],
      });

      const records = await call(
        'GET',
        `/pets/${petId}/records?page=1&pageSize=8`,
        ownerToken,
      );
      expect(records.status).toBe(200);
      expect(parse<medicalRecord.ListRecordsResponse>(records).data?.total).toBe(
        1,
      );
      const vaccinations = await call(
        'GET',
        `/pets/${petId}/vaccinations?page=1&pageSize=8&onlyUpcoming=true`,
        clinicToken,
      );
      expect(
        parse<medicalRecord.ListVaccinationsResponse>(vaccinations).data?.total,
      ).toBe(1);
      expect(
        (
          await call(
            'GET',
            `/pets/${petId}/prescriptions?page=1&pageSize=8&onlyActive=false`,
            clinicToken,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            'GET',
            `/pets/${petId}/lab-results?page=1&pageSize=8&testName=hemo`,
            ownerToken,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            'GET',
            `/pets/${petId}/records?page=1&pageSize=10`,
            ownerToken,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await call(
            'GET',
            `/pets/${petId}/records?page=1&pageSize=8`,
            foreignToken,
          )
        ).status,
      ).toBe(403);
    });

    it('GET /documents/:id yükleyen kliniğe ve hayvanın sahibine açıktır; başka klinik ve başka sahip 404', async () => {
      for (const token of [clinicToken, ownerToken]) {
        const response = await call('GET', `/documents/${documentId}`, token);
        expect(response.status).toBe(200);
        expect(
          parse<medicalRecord.DocumentResponse>(response).data?.document
            ?.status,
        ).toBe(medicalRecord.DocumentStatus.QUEUED);
      }
      for (const token of [foreignToken, strangerToken]) {
        expect(
          (await call('GET', `/documents/${documentId}`, token)).status,
        ).toBe(404);
      }
    });

    // ---Amaç: belge listesinin yükleyen kliniğe ve hayvanın sahibine en yeni önce açıldığını, durum filtresini ve erişim kurallarını doğrulamak ---
    it('GET /pets/:petId/documents belgeleri en yeni önce listeler; durum filtresi çalışır; rızasız klinik 403, başka sahip 404', async () => {
      const path = `/pets/${petId}/documents?page=1&pageSize=8`;
      const names = async (token: string, query = '') => {
        const response = await call('GET', `${path}${query}`, token);
        expect(response.status).toBe(200);
        return parse<medicalRecord.ListDocumentsResponse>(
          response,
        ).data?.documents.map((document) => document.originalName);
      };
      const uploaded = [
        'tam10mb.pdf',
        'aslinda-png.pdf',
        'Kan Tahlili ğüşiöç İ.pdf',
      ];

      expect(await names(clinicToken)).toEqual(uploaded);
      expect(await names(ownerToken)).toEqual(uploaded);
      expect(await names(ownerToken, '&status=1')).toEqual(uploaded);
      expect(await names(ownerToken, '&status=4')).toEqual([]);
      const badStatus = await call('GET', `${path}&status=9`, ownerToken);
      expect([badStatus.status, parse(badStatus).message]).toEqual([
        400,
        'DOCUMENT_STATUS_NOT_VALID',
      ]);
      expect((await call('GET', path, foreignToken)).status).toBe(403);
      expect((await call('GET', path, strangerToken)).status).toBe(404);
    });

    // ---Amaç: dosyanın varsayılan olarak tarayıcıda açılacak, download=1 ile indirilecek biçimde, kayıttaki özetle aynı içerikle döndüğünü ve bozuk ya da eksik dosyanın gönderilmediğini doğrulamak ---
    it('GET /documents/:id/file dosyayı inline, download=1 ile attachment döner; içerik sha256 ile doğrulanır; bozuk dosya 500, eksik dosya 404', async () => {
      const row = await documentOf(documentId);
      const inline = await call(
        'GET',
        `/documents/${documentId}/file`,
        clinicToken,
      );
      expect(inline.status).toBe(200);
      expect(inline.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-length': String(row.size_bytes),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="Kan Tahlili ___i__ _.pdf"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      });
      expect(createHash('sha256').update(inline.rawBody).digest('hex')).toBe(
        row.sha256,
      );

      const download = await call(
        'GET',
        `/documents/${documentId}/file?download=1`,
        ownerToken,
      );
      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toMatch(/^attachment; /);
      expect(download.rawBody.equals(inline.rawBody)).toBe(true);

      for (const token of [foreignToken, strangerToken]) {
        expect(
          (await call('GET', `/documents/${documentId}/file`, token)).status,
        ).toBe(404);
      }
      for (const [path, message] of [
        [`/documents/${documentId}/file?download=evet`, 'DOWNLOAD_NOT_VALID'],
        ['/documents/abc/file', 'DOCUMENT_ID_WRONG DATA FORMAT'],
      ]) {
        const invalid = await call('GET', path, ownerToken);
        expect([invalid.status, parse(invalid).message]).toEqual([
          400,
          message,
        ]);
      }

      const png = parse<medicalRecord.ListDocumentsResponse>(
        await call(
          'GET',
          `/pets/${petId}/documents?page=1&pageSize=8`,
          ownerToken,
        ),
      ).data?.documents.find((document) => document.mimeType === 'image/png');
      const pngRow = await documentOf(png?.id ?? '');
      const image = await call('GET', `/documents/${png?.id}/file`, ownerToken);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(createHash('sha256').update(image.rawBody).digest('hex')).toBe(
        pngRow.sha256,
      );

      for (const tampered of [
        Buffer.alloc(pngRow.size_bytes, 0x41),
        Buffer.alloc(pngRow.size_bytes + 1, 0x41),
      ]) {
        await store.put(pngRow.storage_path, tampered, 'image/png');
        const broken = await call(
          'GET',
          `/documents/${png?.id}/file`,
          ownerToken,
        );
        expect([broken.status, parse(broken).message]).toEqual([
          500,
          'INTERNAL_SERVER_ERROR',
        ]);
      }
      await store.remove(pngRow.storage_path);
      const missing = await call(
        'GET',
        `/documents/${png?.id}/file`,
        ownerToken,
      );
      expect([missing.status, parse(missing).message]).toEqual([
        404,
        'NOT_FOUND',
      ]);
    });

    // ---Amaç: iç içe alanlardaki doğrulama hatasının BAD_REQUEST yerine alanı belirten kodla döndüğünü doğrulamak ---
    it('kayıt ve taslak gövdesindeki iç içe alan hataları alan koduyla 400 döner', async () => {
      const content = {
        type: medicalRecord.RecordType.EXAMINATION,
        title: 'Kontrol',
        recordedAt: today,
      };
      for (const [path, body, message] of [
        [
          `/pets/${petId}/records`,
          { content: { ...content, title: 'a' } },
          'TITLE_MIN_LENGTH|2',
        ],
        [
          `/pets/${petId}/records`,
          { content, attachments: [{ documentId: 'abc' }] },
          'DOCUMENT_ID_WRONG DATA FORMAT',
        ],
        [
          `/draft-reviews/${randomUUID()}/review`,
          { approved: true, editedContent: { ...content, title: 'a' } },
          'TITLE_MIN_LENGTH|2',
        ],
      ] as const) {
        const response = await call('POST', path, clinicToken, body);
        expect([response.status, parse(response).message]).toEqual([
          400,
          message,
        ]);
      }
    });

    it('AI taslağı listelenir; notsuz red 400, notlu red 200; hasta sahibi taslak göremez', async () => {
      await bus.publishAiEvent('analyzed', {
        documentId,
        modelVersion: 'fake-ai-1',
        confidence: 0.8,
        proposal: { type: 'EXAMINATION', title: 'Kontrol', recordedAt: today },
      });

      let draftId = '';
      const deadline = Date.now() + 10_000;
      while (!draftId && Date.now() < deadline) {
        const drafts = await call(
          'GET',
          '/draft-reviews?status=1&page=1&pageSize=8',
          clinicToken,
        );
        draftId =
          parse<medicalRecord.ListDraftReviewsResponse>(
            drafts,
          ).data?.draftReviews.find((d) => d.documentId === documentId)?.id ??
          '';
        if (!draftId) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        }
      }
      expect(draftId).toMatch(UUID_V4);

      const missingNote = await call(
        'POST',
        `/draft-reviews/${draftId}/review`,
        clinicToken,
        { approved: false },
      );
      expect(missingNote.status).toBe(400);
      expect(parse(missingNote).message).toBe('REVIEW_NOTE_NOT_EMPTY');
      const rejected = await call(
        'POST',
        `/draft-reviews/${draftId}/review`,
        clinicToken,
        { approved: false, reviewNote: 'Yanlış belge' },
      );
      expect(rejected.status).toBe(200);
      expect(
        parse<medicalRecord.DraftReviewResponse>(rejected).data?.draftReview
          ?.status,
      ).toBe(medicalRecord.DraftReviewStatus.REJECTED);
      expect(
        (await call('GET', '/draft-reviews?page=1&pageSize=8', ownerToken))
          .status,
      ).toBe(403);
    });
  });
});
