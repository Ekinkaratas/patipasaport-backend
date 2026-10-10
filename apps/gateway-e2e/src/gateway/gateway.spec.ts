import { httpGet, RunningService, startService } from '@libs/e2e-utils';
import { randomUUID } from 'crypto';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
});
