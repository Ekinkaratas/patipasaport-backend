import { Client } from '@grpc/grpc-js';
import {
  callGrpc,
  DOCKER_GRPC_PORTS,
  DOCKER_REDIS_PORTS,
  expectOk,
  grpcClient,
  GrpcResult,
  requireEnv,
  RunningService,
  startService,
  TestData,
  uniqueEmail,
  uniqueLandlinePhone,
  uniqueMobilePhone,
} from '@libs/e2e-utils';
import { access, auth } from '@libs/proto';
import { createHash, randomUUID } from 'crypto';
import { Redis } from 'ioredis';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

const code = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : result.code;

const PASSWORD = 'Guclu.Sifre1';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

interface SessionRow {
  family_id: string;
  client_type: string;
  remember_me: boolean;
  hours: number;
}

describe('auth servisi (e2e)', () => {
  const data = new TestData();
  const emails: string[] = [];
  const opaqueTokens: string[] = [];

  let service: RunningService;
  let authClient: Client;
  let accessClient: Client;
  let redis: Redis;

  const callAuth = <T>(method: string, request: object) =>
    callGrpc<T>(authClient, method, request);

  const track = (result: GrpcResult<auth.TokenResponse>) => {
    if (result.ok) {
      opaqueTokens.push(result.value.accessToken);
      data.trackUser(result.value.userId);
    }
    return result;
  };

  const newEmail = (label: string) => {
    const email = uniqueEmail(label);
    emails.push(email);
    return email;
  };

  const register = async (override: object = {}) =>
    track(
      await callAuth<auth.TokenResponse>('Register', {
        email: newEmail('kayit'),
        password: PASSWORD,
        fullName: 'Ali Veli',
        phone: uniqueMobilePhone(),
        clientType: auth.ClientType.WEB,
        ...override,
      }),
    );

  const login = async (
    email: string,
    override: object = {},
  ): Promise<GrpcResult<auth.TokenResponse>> =>
    track(
      await callAuth<auth.TokenResponse>('Login', {
        email,
        password: PASSWORD,
        clientType: auth.ClientType.WEB,
        ...override,
      }),
    );

  const refresh = async (refreshToken: string, clientType = auth.ClientType.WEB) =>
    track(
      await callAuth<auth.TokenResponse>('RefreshToken', {
        refreshToken,
        clientType,
      }),
    );

  const exchange = (opaqueToken: string, clientType = access.ClientType.WEB) =>
    callGrpc<access.ExchangeTokenResponse>(accessClient, 'ExchangeToken', {
      opaqueToken,
      clientType,
    });

  const hashOf = (token: string) =>
    createHash('sha256').update(token).digest('hex');

  const session = async (refreshToken: string): Promise<SessionRow> => {
    const db = await data.db('auth');
    const { rows } = await db.query<SessionRow>(
      `SELECT family_id, client_type, remember_me,
              round(extract(epoch from expires_at - ${UTC_NOW}) / 3600)::int AS hours
         FROM sessions WHERE refresh_token_hash = $1`,
      [hashOf(refreshToken)],
    );
    return rows[0];
  };

  const family = async (familyId: string) => {
    const db = await data.db('auth');
    const { rows } = await db.query<{ total: number; active: number }>(
      'SELECT count(*)::int AS total, count(*) FILTER (WHERE revoked_at IS NULL)::int AS active FROM sessions WHERE family_id = $1',
      [familyId],
    );
    return rows[0];
  };

  const rowCounts = async (email: string) => {
    const users = await data.db('users');
    const authDb = await data.db('auth');
    const { rows: userRows } = await users.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE email = $1',
      [email],
    );
    const { rows: credentialRows } = await authDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM credentials WHERE email = $1',
      [email],
    );
    return { users: userRows[0].n, credentials: credentialRows[0].n };
  };

  beforeAll(async () => {
    service = await startService('auth');
    authClient = grpcClient('auth', service.port);
    accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
    redis = new Redis({
      host: '127.0.0.1',
      port: DOCKER_REDIS_PORTS.auth,
      password: requireEnv('AUTH_REDIS_PASSWORD'),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
  }, 120_000);

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
      [authClient, accessClient].forEach((client) => client?.close());
      await service?.stop();
    }
  });

  // ---Amaç: kaydın users ve credentials satırlarını tutarlı açtığını, çakışmada yarım kayıt bırakmadığını doğrulamak ---
  describe('Register', () => {
    it('token çifti döner; users, credentials ve oturum satırları tutarlıdır', async () => {
      const email = newEmail('kayit');
      const registered = expectOk(await register({ email }), 'Register');
      expect(registered.tokenType).toBe('Bearer');
      expect(registered.expiresIn).toBe(900);
      expect(registered.userId).toMatch(UUID_V4);
      expect(registered.clinicId).toBe('');
      expect(registered.refreshToken).not.toBe('');

      const users = await data.db('users');
      const { rows: userRows } = await users.query(
        'SELECT id, role, is_active, clinic_id FROM users WHERE email = $1',
        [email],
      );
      expect(userRows[0]).toEqual({
        id: registered.userId,
        role: 'PET_OWNER',
        is_active: true,
        clinic_id: null,
      });

      const authDb = await data.db('auth');
      const { rows: credentialRows } = await authDb.query(
        'SELECT user_id, password_hash FROM credentials WHERE email = $1',
        [email],
      );
      expect(credentialRows[0].user_id).toBe(registered.userId);
      expect(credentialRows[0].password_hash.startsWith('$argon2id$')).toBe(
        true,
      );

      const created = await session(registered.refreshToken);
      expect(created).toMatchObject({
        client_type: 'WEB',
        remember_me: false,
        hours: 12,
      });
      expect(created.family_id).toMatch(UUID_V4);

      const exchanged = expectOk(
        await exchange(registered.accessToken),
        'ExchangeToken',
      );
      expect(exchanged).toMatchObject({
        userId: registered.userId,
        role: 'PET_OWNER',
        clinicId: '',
      });
    });

    it('aynı e-posta ALREADY_EXISTS/EMAIL_ALREADY_EXISTS alır', async () => {
      const email = newEmail('kayit');
      expectOk(await register({ email }), 'Register');
      expect(outcome(await register({ email }))).toBe(
        'ALREADY_EXISTS/EMAIL_ALREADY_EXISTS',
      );
    });

    it('aynı telefon reddedilir, PHONE_ALREADY_EXISTS istemciye sızmaz, yarım kayıt kalmaz', async () => {
      const phone = uniqueMobilePhone();
      expectOk(await register({ phone }), 'Register');
      const email = newEmail('kayit');
      const duplicate = await register({ email, phone });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.ok ? '' : duplicate.details).not.toBe(
        'PHONE_ALREADY_EXISTS',
      );
      expect(await rowCounts(email)).toEqual({ users: 0, credentials: 0 });
    });

    it('bozuk e-posta INVALID_ARGUMENT alır', async () => {
      expect(code(await register({ email: 'bozuk' }))).toBe('INVALID_ARGUMENT');
    });
  });

  // ---Amaç: klinik oluşturma akışında açılan ortak CLINIC hesabının oturum açmadan yazıldığını ve giriş yapabildiğini doğrulamak ---
  describe('RegisterClinicAccount (iç RPC)', () => {
    const registerClinicAccount = (override: object = {}) =>
      callAuth<auth.RegisterClinicAccountResponse>('RegisterClinicAccount', {
        clinicId: randomUUID(),
        email: newEmail('klinikhesap'),
        password: PASSWORD,
        fullName: 'Pati&Can 2 Veteriner',
        phone: uniqueLandlinePhone(),
        ...override,
      });

    it('CLINIC hesabı açar, oturum oluşturmaz; hesapla giriş yapılır ve token klinik rolünü taşır', async () => {
      const clinic = await data.insertClinic();
      const email = newEmail('klinikhesap');
      const phone = uniqueLandlinePhone();
      const result = expectOk(
        await registerClinicAccount({
          clinicId: clinic.id,
          email,
          phone: `0${phone.slice(3)}`,
        }),
        'RegisterClinicAccount',
      );
      data.trackUser(result.userId);
      expect(result.userId).toMatch(UUID_V4);

      const users = await data.db('users');
      const { rows: userRows } = await users.query(
        'SELECT role, clinic_id, full_name, tel_no FROM users WHERE id = $1',
        [result.userId],
      );
      expect(userRows[0]).toEqual({
        role: 'CLINIC',
        clinic_id: clinic.id,
        full_name: 'Pati&Can 2 Veteriner',
        tel_no: phone,
      });

      const authDb = await data.db('auth');
      const { rows: sessionRows } = await authDb.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1',
        [result.userId],
      );
      expect(sessionRows[0].n).toBe(0);

      const loggedIn = expectOk(await login(email), 'Login');
      expect(loggedIn.clinicId).toBe(clinic.id);
      const exchanged = expectOk(
        await exchange(loggedIn.accessToken),
        'ExchangeToken',
      );
      expect(exchanged).toMatchObject({
        userId: result.userId,
        role: 'CLINIC',
        clinicId: clinic.id,
      });
      const refreshed = expectOk(
        await refresh(loggedIn.refreshToken),
        'Refresh',
      );
      expect(refreshed.clinicId).toBe(clinic.id);
    });

    it('kayıtlı e-posta ve telefon yönetici yolunda ayrı ayrı bildirilir, yarım kayıt kalmaz', async () => {
      const taken = await data.insertUser();

      const byEmail = await registerClinicAccount({ email: taken.email });
      expect(outcome(byEmail)).toBe('ALREADY_EXISTS/EMAIL_ALREADY_EXISTS');

      const email = newEmail('klinikhesap');
      const byPhone = await registerClinicAccount({ email, phone: taken.phone });
      expect(outcome(byPhone)).toBe('ALREADY_EXISTS/PHONE_ALREADY_EXISTS');
      expect(await rowCounts(email)).toEqual({ users: 0, credentials: 0 });
    });

    it('bozuk clinicId DTO’da reddedilir', async () => {
      expect(outcome(await registerClinicAccount({ clinicId: 'abc' }))).toBe(
        'INVALID_ARGUMENT/CLINIC_ID_WRONG DATA FORMAT',
      );
    });
  });

  // ---Amaç: girişin e-posta sızdırmadığını, oturum süresinin "beni hatırla"ya göre ayarlandığını ve token'ın istemci tipine bağlandığını doğrulamak ---
  describe('Login', () => {
    let email: string;

    beforeAll(async () => {
      email = newEmail('giris');
      expectOk(await register({ email }), 'Register');
    });

    it('yanlış şifre ile kayıtsız e-posta birebir aynı UNAUTHENTICATED yanıtını alır', async () => {
      const wrong = await login(email, { password: 'Yanlis.Sifre1' });
      const unknown = await login(newEmail('yok'));
      expect(code(wrong)).toBe('UNAUTHENTICATED');
      expect(outcome(unknown)).toBe(outcome(wrong));
    });

    it('bozuk e-posta INVALID_ARGUMENT alır', async () => {
      expect(code(await login('bozuk'))).toBe('INVALID_ARGUMENT');
    });

    it('"beni hatırla" ile oturum ~30 gün; WEB token’ı MOBILE ile kullanılamaz', async () => {
      const loggedIn = expectOk(await login(email, { rememberMe: true }), 'Login');
      const current = await session(loggedIn.refreshToken);
      expect(current.remember_me).toBe(true);
      expect(Math.round(current.hours / 24)).toBe(30);
      expect(outcome(await exchange(loggedIn.accessToken))).toBe('ok');
      expect(
        code(await exchange(loggedIn.accessToken, access.ClientType.MOBILE)),
      ).toBe('UNAUTHENTICATED');
    });

    it('MOBILE giriş MOBILE oturum açar', async () => {
      const loggedIn = expectOk(
        await login(email, { clientType: auth.ClientType.MOBILE }),
        'Login',
      );
      expect((await session(loggedIn.refreshToken)).client_type).toBe('MOBILE');
      expect(
        outcome(await exchange(loggedIn.accessToken, access.ClientType.MOBILE)),
      ).toBe('ok');
    });
  });

  // ---Amaç: refresh token rotasyonunu, kısa tekrar toleransını, hırsızlık tespitini ve yarış güvenliğini doğrulamak ---
  describe('RefreshToken', () => {
    let email: string;

    beforeAll(async () => {
      email = newEmail('yenileme');
      expectOk(await register({ email }), 'Register');
    });

    it('rotasyon: yeni çift aynı ailede, remember_me korunur; eski refresh 10 sn içinde reddedilir ama aile yaşar', async () => {
      const loggedIn = expectOk(await login(email, { rememberMe: true }), 'Login');
      const familyId = (await session(loggedIn.refreshToken)).family_id;

      const first = expectOk(await refresh(loggedIn.refreshToken), 'Refresh');
      expect(first.refreshToken).not.toBe(loggedIn.refreshToken);
      const rotated = await session(first.refreshToken);
      expect(rotated.family_id).toBe(familyId);
      expect(rotated.remember_me).toBe(true);
      expect(await family(familyId)).toEqual({ total: 2, active: 1 });
      expect(outcome(await exchange(first.accessToken))).toBe('ok');

      expect(code(await refresh(loggedIn.refreshToken))).toBe('UNAUTHENTICATED');
      expectOk(await refresh(first.refreshToken), 'Refresh (güncel)');
      const after = await family(familyId);
      expect(after.total).toBeLessThanOrEqual(2);
      expect(after.active).toBe(1);
    });

    it('10 sn’den eski bir refresh tekrar kullanılırsa tüm aile iptal edilir', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      const familyId = (await session(loggedIn.refreshToken)).family_id;
      const first = expectOk(await refresh(loggedIn.refreshToken), 'Refresh');
      const second = expectOk(await refresh(first.refreshToken), 'Refresh');

      const db = await data.db('auth');
      await db.query(
        `UPDATE sessions SET revoked_at = ${UTC_NOW} - interval '11 seconds' WHERE refresh_token_hash = $1`,
        [hashOf(first.refreshToken)],
      );
      expect(code(await refresh(first.refreshToken))).toBe('UNAUTHENTICATED');
      expect((await family(familyId)).active).toBe(0);
      expect(code(await refresh(second.refreshToken))).toBe('UNAUTHENTICATED');
    });

    it('WEB oturumu MOBILE olarak yenilenemez', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      expect(
        code(await refresh(loggedIn.refreshToken, auth.ClientType.MOBILE)),
      ).toBe('UNAUTHENTICATED');
    });

    it('aynı refresh ile iki paralel yenilemeden yalnızca biri başarılı olur', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      const results = await Promise.all([
        refresh(loggedIn.refreshToken),
        refresh(loggedIn.refreshToken),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });
  });

  // ---Amaç: çıkışın oturum ailesini ve opaque token'ı iptal ettiğini, uydurma token'la hiçbir oturumun silinmediğini doğrulamak ---
  describe('Logout', () => {
    let email: string;

    beforeAll(async () => {
      email = newEmail('cikis');
      expectOk(await register({ email }), 'Register');
    });

    it('refresh + opaque ile çıkış aileyi siler ve access token’ı geçersiz kılar', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      const familyId = (await session(loggedIn.refreshToken)).family_id;
      const result = expectOk(
        await callAuth<auth.LogoutResponse>('Logout', {
          refreshToken: loggedIn.refreshToken,
          opaqueToken: loggedIn.accessToken,
        }),
        'Logout',
      );
      expect(result.success).toBe(true);
      expect((await family(familyId)).total).toBe(0);
      expect(code(await exchange(loggedIn.accessToken))).toBe('UNAUTHENTICATED');
      expect(
        code(
          await callAuth('Logout', { refreshToken: loggedIn.refreshToken }),
        ),
      ).toBe('UNAUTHENTICATED');
    });

    it('uydurma refresh ile çıkış UNAUTHENTICATED alır ve kullanıcının oturumları silinmez', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      const familyId = (await session(loggedIn.refreshToken)).family_id;
      expect(
        code(
          await callAuth('Logout', {
            refreshToken: 'uydurma-token',
            opaqueToken: 'x',
          }),
        ),
      ).toBe('UNAUTHENTICATED');
      expect((await family(familyId)).total).toBe(1);
    });

    it('opaque token olmadan çıkış başarılıdır', async () => {
      const loggedIn = expectOk(await login(email), 'Login');
      expect(
        outcome(
          await callAuth('Logout', { refreshToken: loggedIn.refreshToken }),
        ),
      ).toBe('ok');
    });
  });

  // ---Amaç: pasif hesabın hem girişte hem token yenilemede ACCOUNT_DISABLED aldığını doğrulamak ---
  describe('pasif hesap', () => {
    it('giriş ve yenileme PERMISSION_DENIED/ACCOUNT_DISABLED alır', async () => {
      const email = newEmail('pasif');
      const registered = expectOk(await register({ email }), 'Register');
      const users = await data.db('users');
      await users.query('UPDATE users SET is_active = false WHERE id = $1', [
        registered.userId,
      ]);
      expect(outcome(await login(email))).toBe(
        'PERMISSION_DENIED/ACCOUNT_DISABLED',
      );
      expect(outcome(await refresh(registered.refreshToken))).toBe(
        'PERMISSION_DENIED/ACCOUNT_DISABLED',
      );
    });
  });

  // ---Amaç: hatalı giriş kilidinin sırayla ve eşzamanlı denemelerde tam 5 denemeye izin verdiğini doğrulamak ---
  describe('giriş kilidi (gerçek Redis)', () => {
    it('5 yanlış denemeden sonra doğru şifre de RESOURCE_EXHAUSTED alır', async () => {
      const email = newEmail('kilit');
      expectOk(await register({ email }), 'Register');
      const attempts: string[] = [];
      for (let i = 0; i < 5; i++) {
        attempts.push(code(await login(email, { password: 'Yanlis.Sifre1' })));
      }
      expect(attempts).toEqual(Array(5).fill('UNAUTHENTICATED'));
      expect(code(await login(email))).toBe('RESOURCE_EXHAUSTED');
    });

    it('20 eşzamanlı yanlış denemeden tam 5’i değerlendirilir, 15’i kilide takılır', async () => {
      const email = newEmail('kilit');
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          login(email, { password: 'Yanlis.Sifre1' }),
        ),
      );
      const tally = results.reduce<Record<string, number>>((acc, result) => {
        acc[code(result)] = (acc[code(result)] ?? 0) + 1;
        return acc;
      }, {});
      expect(tally).toEqual({ UNAUTHENTICATED: 5, RESOURCE_EXHAUSTED: 15 });
    });
  });
});
