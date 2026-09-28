import { Injectable, Logger } from '@nestjs/common';
import { rejectRpc, ResponseMessages } from '@libs/common';
import { RedisService } from './redis.service';

/** 15 dakika içinde bu kadar hatalı deneme hesabı kilitler. */
export const MAX_FAILED_ATTEMPTS = 5;
export const FAILURE_WINDOW_SECONDS = 15 * 60;

/** Art arda kilitlerde süre kademesi: 5 → 15 → 30 → 60 dk, sonra 60'ta sabit. */
export const LOCK_STEPS_SECONDS = [5 * 60, 15 * 60, 30 * 60, 60 * 60] as const;

/** 24 saat hiç hatalı deneme olmazsa kademe sıfırlanır. */
export const LOCK_LEVEL_RESET_SECONDS = 24 * 60 * 60;

export interface FailureResult {
  /** Bu deneme hesabı kilitledi mi? */
  locked: boolean;
  /** Kilit yeni konduysa süresi (sn), aksi halde 0. */
  lockSeconds: number;
  /** Kilide kalan hatalı deneme hakkı (kilitlendiyse 0). */
  remainingAttempts: number;
}

/**
 * Email bazlı hatalı giriş kilidi. Redis anahtarları:
 *
 *   auth:login-fail:<email>        pencere içindeki hatalı deneme sayacı (TTL 15 dk,
 *                                  ilk hatada başlar, sonraki hatalar uzatmaz)
 *   auth:login-lock:<email>        varsa hesap kilitli; TTL = kilit süresi
 *   auth:login-lock-level:<email>  bugüne kadarki kilit sayısı (kademe);
 *                                  her hatalı denemede TTL 24 saate yenilenir
 *
 * Login akışında kullanım:
 *   1. assertNotLocked(email)      — şifre kontrolünden ÖNCE
 *   2. şifre yanlışsa recordFailure(email)
 *   3. giriş başarılıysa reset(email)
 */
@Injectable()
export class LoginAttemptService {
  private readonly logger = new Logger(LoginAttemptService.name);

  constructor(private readonly redis: RedisService) {}

  /** Kilitliyse TOO_MANY_REQUESTS (gRPC RESOURCE_EXHAUSTED → HTTP 429) fırlatır. */
  async assertNotLocked(email: string): Promise<void> {
    const remaining = await this.redis.ttl(this.lockKey(email));
    // -2: anahtar yok. -1 (TTL'siz) hiç yazılmaz ama olursa kilitli sayılır.
    if (remaining !== -2) {
      rejectRpc(
        this.logger,
        ResponseMessages.TOO_MANY_REQUESTS,
        `hesap kilitli, kalan ${remaining} sn`,
      );
    }
  }

  async recordFailure(email: string): Promise<FailureResult> {
    const levelKey = this.levelKey(email);
    const count = await this.redis.incrementWithTtl(
      this.failKey(email),
      FAILURE_WINDOW_SECONDS,
    );
    // Kademe "24 saat hatasızlık" ile sıfırlanır: her hata süreyi baştan başlatır.
    await this.redis.expire(levelKey, LOCK_LEVEL_RESET_SECONDS);

    // INCR atomik: eşzamanlı isteklerden yalnızca biri tam 5'i görür, böylece
    // aynı pencere için kademe iki kez artmaz.
    if (count !== MAX_FAILED_ATTEMPTS) {
      return {
        locked: false,
        lockSeconds: 0,
        remainingAttempts: Math.max(MAX_FAILED_ATTEMPTS - count, 0),
      };
    }

    const level = await this.redis.incrementWithTtl(
      levelKey,
      LOCK_LEVEL_RESET_SECONDS,
    );
    const lockSeconds =
      LOCK_STEPS_SECONDS[Math.min(level, LOCK_STEPS_SECONDS.length) - 1];

    await this.redis.setWithTtl(
      this.lockKey(email),
      String(level),
      lockSeconds,
    );
    // Kilit bitince yeni 5 denemelik pencere başlasın.
    await this.redis.delete(this.failKey(email));

    this.logger.warn(
      `hesap kilitlendi (kademe=${level}, süre=${lockSeconds} sn)`,
    );
    return { locked: true, lockSeconds, remainingAttempts: 0 };
  }

  /** Başarılı girişte sayaç, kilit ve kademe temizlenir. */
  async reset(email: string): Promise<void> {
    await this.redis.delete(
      this.failKey(email),
      this.lockKey(email),
      this.levelKey(email),
    );
  }

  // Login DTO email'i normalize etmiyor; aynı adresin farklı yazımları
  // ayrı sayaç açıp kilidi atlatmasın diye anahtar burada normalize edilir.
  private static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  private failKey(email: string): string {
    return `auth:login-fail:${LoginAttemptService.normalize(email)}`;
  }

  private lockKey(email: string): string {
    return `auth:login-lock:${LoginAttemptService.normalize(email)}`;
  }

  private levelKey(email: string): string {
    return `auth:login-lock-level:${LoginAttemptService.normalize(email)}`;
  }
}
