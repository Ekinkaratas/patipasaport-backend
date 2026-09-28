import { RpcException } from '@nestjs/microservices';
import { ResponseMessages } from '@libs/common';
import {
  FailureResult,
  LOCK_LEVEL_RESET_SECONDS,
  LoginAttemptService,
} from './login-attempt.service';
import { RedisService } from './redis.service';

class FakeRedis {
  private store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async incrementWithTtl(key: string, ttl: number) {
    const e = this.live(key);
    const value = String(Number(e?.value ?? 0) + 1);
    this.store.set(key, {
      value,
      expiresAt: e ? e.expiresAt : Date.now() + ttl * 1000,
    });
    return Number(value);
  }
  async expire(key: string, ttl: number) {
    const e = this.live(key);
    if (!e) return false;
    e.expiresAt = Date.now() + ttl * 1000;
    return true;
  }
  async ttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }
  async setWithTtl(key: string, value: string, ttl: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async delete(...keys: string[]) {
    return keys.filter((k) => this.store.delete(k)).length;
  }
}

const MIN = 60 * 1000;
const EMAIL = 'ali@example.com';

describe('LoginAttemptService', () => {
  let service: LoginAttemptService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    service = new LoginAttemptService(
      new FakeRedis() as unknown as RedisService,
    );
  });
  afterEach(() => jest.useRealTimers());

  const failTimes = async (n: number, email = EMAIL) => {
    const results: FailureResult[] = [];
    for (let i = 0; i < n; i++)
      results.push(await service.recordFailure(email));
    return results[results.length - 1];
  };
  const expectLocked = async (email = EMAIL) => {
    const error = await service.assertNotLocked(email).catch((e) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect(error.message).toBe(ResponseMessages.TOO_MANY_REQUESTS);
  };
  const expectUnlocked = (email = EMAIL) =>
    expect(service.assertNotLocked(email)).resolves.toBeUndefined();

  it('4 hatalı deneme kilitlemez, kalan hakkı bildirir', async () => {
    expect(await failTimes(4)).toEqual({
      locked: false,
      lockSeconds: 0,
      remainingAttempts: 1,
    });
    await expectUnlocked();
  });

  it('5. hatalı deneme 5 dk kilitler', async () => {
    expect(await failTimes(5)).toEqual({
      locked: true,
      lockSeconds: 300,
      remainingAttempts: 0,
    });
    await expectLocked();
    jest.advanceTimersByTime(5 * MIN - 1000);
    await expectLocked();
    jest.advanceTimersByTime(1000);
    await expectUnlocked();
  });

  it('art arda kilitler 5 → 15 → 30 → 60 dk, sonra 60 dk sabit', async () => {
    for (const expected of [300, 900, 1800, 3600, 3600, 3600]) {
      const result = await failTimes(5);
      expect(result.lockSeconds).toBe(expected);
      jest.advanceTimersByTime(expected * 1000);
      await expectUnlocked();
    }
  });

  it('kilitten sonra yeni 5 denemelik pencere başlar', async () => {
    await failTimes(5);
    jest.advanceTimersByTime(5 * MIN);
    expect((await failTimes(1)).remainingAttempts).toBe(4);
  });

  it('15 dk penceresi dışına taşan hatalar birikmez', async () => {
    await failTimes(4);
    jest.advanceTimersByTime(15 * MIN);
    expect(await failTimes(1)).toEqual({
      locked: false,
      lockSeconds: 0,
      remainingAttempts: 4,
    });
  });

  it('pencere sonraki hatalarla uzamaz', async () => {
    await failTimes(1);
    jest.advanceTimersByTime(14 * MIN);
    await failTimes(3); // 4. hata, pencerenin 14. dakikası
    jest.advanceTimersByTime(1 * MIN); // pencere doldu
    expect((await failTimes(1)).locked).toBe(false);
  });

  it('24 saat hiç hatalı deneme olmazsa kademe sıfırlanır', async () => {
    await failTimes(5); // kademe 1 → 5 dk
    jest.advanceTimersByTime(LOCK_LEVEL_RESET_SECONDS * 1000);
    expect((await failTimes(5)).lockSeconds).toBe(300);
  });

  it('24 saat içinde gelen her hata kademe süresini yeniler', async () => {
    await failTimes(5); // kademe 1
    jest.advanceTimersByTime(23 * 60 * MIN);
    await failTimes(1); // kademe TTL'i 24 saate yenilendi
    jest.advanceTimersByTime(2 * 60 * MIN); // ilk kilitten 25 saat sonra
    expect((await failTimes(5)).lockSeconds).toBe(900); // kademe 2
  });

  it('reset sayaç, kilit ve kademeyi temizler', async () => {
    await failTimes(5);
    await service.reset(EMAIL);
    await expectUnlocked();
    expect((await failTimes(4)).remainingAttempts).toBe(1);
    expect((await failTimes(1)).lockSeconds).toBe(300);
  });

  it('email büyük/küçük harf ve boşluk farkı aynı sayaca yazılır', async () => {
    await failTimes(2, 'Ali@Example.com');
    await failTimes(3, '  ali@example.COM ');
    await expectLocked('ALI@example.com');
  });

  it('farklı email kilitten etkilenmez', async () => {
    await failTimes(5);
    await expectUnlocked('veli@example.com');
  });
});
