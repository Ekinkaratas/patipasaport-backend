import {
  DOCKER_GRPC_PORTS,
  E2E_PORTS,
  httpGet,
  httpRequest,
  HttpResponse,
  httpUpload,
  RunningService,
  samplePdf,
  startService,
  WORKSPACE_ROOT,
} from '@libs/e2e-utils';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';

const ALLOWED_ORIGIN = 'http://izinli.example';
const SECOND_ORIGIN = 'http://ikinci.example';
const FOREIGN_ORIGIN = 'http://yabanci.example';
const DEPTH_MESSAGE =
  'İstek gövdesi çok karmaşık (maksimum derinlik sınırı aşıldı).';

const nestedJson = (levels: number): string =>
  `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;

interface Envelope {
  data: unknown;
  message: string;
  success: boolean;
  correlationId?: string;
}

const parse = (response: HttpResponse): Envelope =>
  JSON.parse(response.body) as Envelope;

const expectThrottled = (response: HttpResponse) => {
  expect(response.status).toBe(429);
  expect(parse(response)).toMatchObject({
    data: null,
    message: 'TOO_MANY_REQUESTS',
    success: false,
  });
  const retryAfter = Number(response.headers['retry-after']);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
};

const runGatewayUntilExit = (
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [resolve(WORKSPACE_ROOT, 'dist/apps/gateway/main.js')],
      {
        cwd: WORKSPACE_ROOT,
        env: {
          ...process.env,
          PORT: String(E2E_PORTS.gateway),
          ACCESS_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.access}`,
          AUTH_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.auth}`,
          CLINICS_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.clinics}`,
          MEDICAL_RECORD_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.medical_record}`,
          PETS_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.pets}`,
          USERS_GRPC_URL: `127.0.0.1:${DOCKER_GRPC_PORTS.users}`,
          S3_ENDPOINT: 'http://127.0.0.1:8333',
          S3_BUCKET: 'medical-documents',
          S3_ACCESS_KEY: 'e2e',
          S3_SECRET_KEY: 'e2e',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });

describe('gateway güvenlik katmanı (e2e)', () => {
  describe('güvenlik başlıkları ve CORS', () => {
    let service: RunningService;

    beforeAll(async () => {
      service = await startService('gateway', {
        CORS_ORIGINS: `${ALLOWED_ORIGIN}, ${SECOND_ORIGIN}`,
      });
    }, 120_000);

    afterAll(async () => {
      await service?.stop();
    });

    // ---Amaç: başarılı ve hatalı yanıtların helmet güvenlik başlıklarını ve no-store önbellek yasağını taşıdığını, X-Powered-By göndermediğini doğrulamak ---
    it.each([
      ['/health', 200],
      ['/olmayan-yol', 404],
    ])('%s yanıtı güvenlik başlıklarını taşır', async (path, status) => {
      const response = await httpGet(service.port, path);
      expect(response.status).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cross-origin-resource-policy']).toBe(
        'same-origin',
      );
    });

    // ---Amaç: listedeki origin'in preflight isteğinde onaylandığını ve yalnızca tanımlı başlıklara izin verildiğini doğrulamak ---
    it('izinli origin preflight isteğinde 204 ve CORS izin başlıklarını alır', async () => {
      const response = await httpRequest(
        service.port,
        'OPTIONS',
        '/auth/login',
        {
          headers: {
            origin: ALLOWED_ORIGIN,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-client-type',
          },
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        ALLOWED_ORIGIN,
      );
      expect(response.headers['access-control-allow-headers']).toBe(
        'Authorization,Content-Type,X-Client-Type,X-Correlation-Id',
      );
      expect(response.headers['access-control-allow-methods']).toContain(
        'POST',
      );
      expect(
        response.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    });

    // ---Amaç: listede olmayan origin'e ne preflight'ta ne de normal istekte CORS izni verilmediğini doğrulamak ---
    it('listede olmayan origin Access-Control-Allow-Origin almaz', async () => {
      const preflight = await httpRequest(
        service.port,
        'OPTIONS',
        '/auth/login',
        {
          headers: {
            origin: FOREIGN_ORIGIN,
            'access-control-request-method': 'POST',
          },
        },
      );
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

      const simple = await httpGet(service.port, '/health', {
        origin: FOREIGN_ORIGIN,
      });
      expect(simple.status).toBe(200);
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
    });

    // ---Amaç: listedeki ikinci origin'in de izin aldığını ve Retry-After başlığının tarayıcıya açıldığını doğrulamak ---
    it('listedeki her origin normal istekte izin ve Retry-After erişimi alır', async () => {
      const response = await httpGet(service.port, '/health', {
        origin: SECOND_ORIGIN,
      });
      expect(response.headers['access-control-allow-origin']).toBe(
        SECOND_ORIGIN,
      );
      expect(response.headers['access-control-expose-headers']).toBe(
        'Retry-After',
      );
      expect(response.headers['vary']).toContain('Origin');
    });
  });

  describe('genel hız sınırı', () => {
    let service: RunningService;

    beforeAll(async () => {
      service = await startService('gateway', { RATE_LIMIT_GLOBAL: '3' });
    }, 120_000);

    afterAll(async () => {
      await service?.stop();
    });

    // ---Amaç: genel sınırın IP başına tüm uçlarda ortak sayıldığını, token kontrolünden önce uygulandığını ve /health'in muaf olduğunu doğrulamak ---
    it('farklı uçlara giden istekler ortak sayılır, aşımda 429 ve Retry-After döner', async () => {
      const statuses: number[] = [];
      for (const path of [
        '/consents',
        '/users/me',
        `/clinics/${randomUUID()}`,
      ]) {
        statuses.push((await httpGet(service.port, path)).status);
      }
      expect(statuses).toEqual([401, 401, 401]);

      expectThrottled(await httpGet(service.port, '/pets'));

      const health = await httpGet(service.port, '/health');
      expect(health.status).toBe(200);
    });
  });

  describe('auth hız sınırı', () => {
    let service: RunningService;

    beforeAll(async () => {
      service = await startService('gateway', { RATE_LIMIT_AUTH: '2' });
    }, 120_000);

    afterAll(async () => {
      await service?.stop();
    });

    // ---Amaç: login, register ve refresh uçlarının IP başına tek sayacı paylaştığını, logout ve diğer uçların bu sayaçtan etkilenmediğini doğrulamak ---
    it('login, register ve refresh ortak sayılır; aşımda 429 döner, diğer uçlar etkilenmez', async () => {
      const login = await httpRequest(service.port, 'POST', '/auth/login', {
        body: {},
      });
      const register = await httpRequest(
        service.port,
        'POST',
        '/auth/register',
        { body: {} },
      );
      expect([login.status, register.status]).toEqual([400, 400]);

      expectThrottled(
        await httpRequest(service.port, 'POST', '/auth/refresh', { body: {} }),
      );
      expectThrottled(
        await httpRequest(service.port, 'POST', '/auth/login', { body: {} }),
      );

      const logout = await httpRequest(service.port, 'POST', '/auth/logout', {
        body: {},
      });
      expect(logout.status).toBe(400);
      expect((await httpGet(service.port, '/consents')).status).toBe(401);
    });
  });

  describe('belge yükleme hız sınırı', () => {
    let service: RunningService;

    beforeAll(async () => {
      service = await startService('gateway', { RATE_LIMIT_UPLOAD: '1' });
    }, 120_000);

    afterAll(async () => {
      await service?.stop();
    });

    // ---Amaç: belge yükleme ucunun kendi sayacıyla sınırlandığını ve diğer uçları etkilemediğini doğrulamak ---
    it('sınır aşılınca yükleme 429 döner, diğer uçlar etkilenmez', async () => {
      const path = `/clinics/${randomUUID()}/pets/${randomUUID()}/documents`;
      const file = {
        field: 'file',
        filename: 'sonuc.pdf',
        contentType: 'application/pdf',
        content: samplePdf(),
      };

      expect((await httpUpload(service.port, path, { file })).status).toBe(401);
      expectThrottled(await httpUpload(service.port, path, { file }));
      expect((await httpGet(service.port, '/consents')).status).toBe(401);
    });
  });

  describe('JSON gövde derinlik sınırı', () => {
    let service: RunningService;

    const login = (rawJson: string) =>
      httpRequest(service.port, 'POST', '/auth/login', {
        headers: { 'x-client-type': '1' },
        rawJson,
      });

    beforeAll(async () => {
      service = await startService('gateway');
    }, 120_000);

    afterAll(async () => {
      await service?.stop();
    });

    // ---Amaç: 50 seviyeyi aşan gövdenin, eskiden 500'e yol açan 15000 seviyelik gövde dahil, 400 ve Türkçe mesajla reddedildiğini doğrulamak ---
    it.each([
      ['51 seviyelik', 50],
      ['15000 seviyelik', 14999],
    ])('%s gövde 400 ve açıklayıcı mesajla reddedilir', async (_n, levels) => {
      const response = await login(
        `{"email":"kullanici@example.com","password":"Guclu.Sifre1","extra":${nestedJson(levels)}}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(parse(response)).toMatchObject({
        data: null,
        message: DEPTH_MESSAGE,
        success: false,
      });
    });

    // ---Amaç: kök dahil 50 seviyelik gövdenin derinlik nedeniyle reddedilmeyip doğrulamaya ulaştığını doğrulamak ---
    it('50 seviyelik gövde derinlik sınırına takılmaz', async () => {
      const response = await login(`{"extra":${nestedJson(49)}}`);
      expect(response.status).toBe(400);
      expect(parse(response).message).not.toBe(DEPTH_MESSAGE);
    });
  });

  describe('trust proxy', () => {
    const consents = (port: number, forwardedFor: string) =>
      httpGet(port, '/consents', { 'x-forwarded-for': forwardedFor });

    describe('TRUST_PROXY=1', () => {
      let service: RunningService;

      beforeAll(async () => {
        service = await startService('gateway', {
          TRUST_PROXY: '1',
          RATE_LIMIT_GLOBAL: '2',
        });
      }, 120_000);

      afterAll(async () => {
        await service?.stop();
      });

      // ---Amaç: istemci IP'sinin vekilin eklediği son X-Forwarded-For girdisinden alındığını, başa yazılan sahte IP'nin sınırı aşmaya yaramadığını ve her istemcinin ayrı sayaç aldığını doğrulamak ---
      it('sayaç son X-Forwarded-For girdisine göre tutulur, sahte ön ek yok sayılır', async () => {
        expect((await consents(service.port, '203.0.113.10')).status).toBe(401);
        expect((await consents(service.port, '203.0.113.10')).status).toBe(401);
        expectThrottled(await consents(service.port, '203.0.113.10'));
        expectThrottled(
          await consents(service.port, '198.51.100.99, 203.0.113.10'),
        );
        expect((await consents(service.port, '203.0.113.20')).status).toBe(401);
      });
    });

    describe('TRUST_PROXY boş', () => {
      let service: RunningService;

      beforeAll(async () => {
        service = await startService('gateway', { RATE_LIMIT_GLOBAL: '2' });
      }, 120_000);

      afterAll(async () => {
        await service?.stop();
      });

      // ---Amaç: trust proxy kapalıyken istemcinin gönderdiği X-Forwarded-For başlığının dikkate alınmadığını, isteklerin bağlantı adresine göre tek sayaçta toplandığını doğrulamak ---
      it('X-Forwarded-For yok sayılır, istekler tek sayaçta toplanır', async () => {
        expect((await consents(service.port, '203.0.113.10')).status).toBe(401);
        expect((await consents(service.port, '203.0.113.20')).status).toBe(401);
        expectThrottled(await consents(service.port, '203.0.113.30'));
      });
    });

    // ---Amaç: herkese güvenen TRUST_PROXY=true değerinde gateway'in açılmayıp değişkenin adını içeren hatayla durduğunu doğrulamak ---
    it('TRUST_PROXY=true ile gateway açılmaz', async () => {
      const result = await runGatewayUntilExit({ TRUST_PROXY: 'true' });
      expect(result.code).not.toBeNull();
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('TRUST_PROXY geçersiz: "true"');
    }, 30_000);
  });
});
