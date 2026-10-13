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

    it('POST /auth/register 201 ve CREATED zarfında token çifti döner; token başlıktaki istemci tipine bağlıdır', async () => {
      const { response, envelope } = await register();

      expect(response.status).toBe(201);
      expect(envelope).toMatchObject({ message: 'CREATED', success: true });
      expect(envelope.correlationId).toBe(response.headers['x-correlation-id']);
      expect(envelope.data).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(envelope.data?.userId).toMatch(UUID_V4);
      expect(envelope.data?.refreshToken).not.toBe('');

      const token = envelope.data?.accessToken ?? '';
      expect(code(await exchange(token, access.ClientType.WEB))).toBe('ok');
      expect(code(await exchange(token, access.ClientType.MOBILE))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('MOBILE başlığıyla kayıt MOBILE token’ı üretir', async () => {
      const { envelope } = await register({}, MOBILE);
      expect(
        code(await exchange(envelope.data?.accessToken ?? '', access.ClientType.MOBILE)),
      ).toBe('ok');
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

    it('POST /auth/refresh 200 ile yeni çift verir; eski refresh token tekrar kullanılınca 401', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const first = (await login(email)).envelope.data as TokenData;

      const refreshed = await post(
        '/auth/refresh',
        { refreshToken: first.refreshToken },
        WEB,
      );
      const envelope = track(refreshed);
      expect(refreshed.status).toBe(200);
      expect(envelope).toMatchObject({ message: 'SUCCESS', success: true });
      expect(envelope.data?.refreshToken).not.toBe(first.refreshToken);

      const reused = await post(
        '/auth/refresh',
        { refreshToken: first.refreshToken },
        WEB,
      );
      expect(reused.status).toBe(401);
      expect(parse(reused).message).toBe('UNAUTH');
    });

    it('POST /auth/logout token istemez; Authorization başlığındaki access token da iptal edilir', async () => {
      const email = newEmail('gateway');
      await register({ email });
      const tokens = (await login(email)).envelope.data as TokenData;

      const response = await post(
        '/auth/logout',
        { refreshToken: tokens.refreshToken },
        { authorization: `Bearer ${tokens.accessToken}` },
      );
      expect(response.status).toBe(200);
      expect(parse(response)).toMatchObject({
        data: { success: true },
        message: 'SUCCESS',
        success: true,
      });
      expect(code(await exchange(tokens.accessToken, access.ClientType.WEB))).toBe(
        'UNAUTHENTICATED',
      );
      expect(
        (
          await post(
            '/auth/refresh',
            { refreshToken: tokens.refreshToken },
            WEB,
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
        const tokens = (await login(email)).envelope.data as TokenData;
        const response = await post(
          '/auth/logout',
          variant.body(tokens),
          variant.headers(tokens),
        );
        expect(response.status).toBe(200);
        expect(code(await exchange(tokens.accessToken, access.ClientType.WEB))).toBe(
          'ok',
        );
        expect(
          (
            await post(
              '/auth/refresh',
              { refreshToken: tokens.refreshToken },
              WEB,
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

    it('POST /clinics/:clinicId/stock-items 201 CREATED; yoldaki klinik esas alınır; başka kliniğin yolu 403', async () => {
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
        },
      );
      expect(response.status).toBe(201);
      expect(parse<clinics.StockItemResponse>(response)).toMatchObject({
        message: 'CREATED',
        data: { item: { clinicId: clinic.id, isBelowCritical: true } },
      });

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

    it('GET /documents/:id yalnızca yükleyen kliniğe açıktır', async () => {
      const own = await call('GET', `/documents/${documentId}`, clinicToken);
      expect(own.status).toBe(200);
      expect(
        parse<medicalRecord.DocumentResponse>(own).data?.document?.status,
      ).toBe(medicalRecord.DocumentStatus.QUEUED);
      expect(
        (await call('GET', `/documents/${documentId}`, foreignToken)).status,
      ).toBe(404);
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
