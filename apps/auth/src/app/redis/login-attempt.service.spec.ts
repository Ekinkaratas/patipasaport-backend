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

  // Login akışındaki sırayı birebir uygular: önce deneme rezerve edilir,
  // şifre yanlış çıkınca aynı sıra numarasıyla hata kaydedilir.
  const failTimes = async (n: number, email = EMAIL) => {
    const results: FailureResult[] = [];
    for (let i = 0; i < n; i++) {
      const attempt = await service.reserveAttempt(email);
      results.push(await service.recordFailure(email, attempt));
    }
    return results[results.length - 1];
  };
  const expectTooMany = async (promise: Promise<unknown>) => {
    const error = (await promise.catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RpcException);
    expect(error.message).toBe(ResponseMessages.TOO_MANY_REQUESTS);
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

  describe('reserveAttempt', () => {
    it('sıra numarasını 1den başlayarak döner', async () => {
      await expect(service.reserveAttempt(EMAIL)).resolves.toBe(1);
      await expect(service.reserveAttempt(EMAIL)).resolves.toBe(2);
    });

    it('deneme şifre kontrolünden önce sayılır: sonucu bekleyen 5 denemeden sonra 6. reddedilir', async () => {
      for (let i = 1; i <= 5; i++) {
        await expect(service.reserveAttempt(EMAIL)).resolves.toBe(i);
      }
      await expectTooMany(service.reserveAttempt(EMAIL));
    });

    it('eşzamanlı 20 istekten yalnızca 5i sıra numarası alır, kalanı reddedilir', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => service.reserveAttempt(EMAIL)),
      );

      const granted = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as PromiseFulfilledResult<number>).value)
        .sort((a, b) => a - b);
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(granted).toEqual([1, 2, 3, 4, 5]);
      expect(rejected).toHaveLength(15);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason.message).toBe(
          ResponseMessages.TOO_MANY_REQUESTS,
        );
      }
    });

    it('hesap kilitliyken reddeder ve sayacı artırmaz', async () => {
      await failTimes(5);
      for (let i = 0; i < 3; i++) {
        await expectTooMany(service.reserveAttempt(EMAIL));
      }

      jest.advanceTimersByTime(5 * MIN);
      await expect(service.reserveAttempt(EMAIL)).resolves.toBe(1);
    });

    it('reset rezerve edilmiş denemeleri de siler', async () => {
      await service.reserveAttempt(EMAIL);
      await service.reserveAttempt(EMAIL);
      await service.reset(EMAIL);

      await expect(service.reserveAttempt(EMAIL)).resolves.toBe(1);
    });
  });

  describe('recordFailure', () => {
    it('5 numaralı olmayan deneme kilitlemez ve kalan hakkı sıra numarasından hesaplar', async () => {
      await expect(service.recordFailure(EMAIL, 3)).resolves.toEqual({
        locked: false,
        lockSeconds: 0,
        remainingAttempts: 2,
      });
      await expectUnlocked();
    });

    it('sonuçlar sırasız gelse de kilidi yalnızca 5 numaralı deneme koyar', async () => {
      const attempts: number[] = [];
      for (let i = 0; i < 5; i++) {
        attempts.push(await service.reserveAttempt(EMAIL));
      }

      // 5. deneme diğerlerinden önce bitti
      expect((await service.recordFailure(EMAIL, attempts[4])).locked).toBe(
        true,
      );
      for (const attempt of attempts.slice(0, 4)) {
        expect((await service.recordFailure(EMAIL, attempt)).locked).toBe(
          false,
        );
      }

      // kademe iki kez artmadı: sonraki kilit hâlâ 15 dk (kademe 2)
      jest.advanceTimersByTime(5 * MIN);
      expect((await failTimes(5)).lockSeconds).toBe(900);
    });
  });
});
