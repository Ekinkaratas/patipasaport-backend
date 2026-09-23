import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, RedisOptions } from 'ioredis';
import { createHash } from 'crypto';
import { access } from '@libs/proto';

/**
 * Kayıt HER ZAMAN TTL'li yazılır — opaque token'ın kendi ömrünü asla aşmaz.
 */
export interface OpaqueTokenRecord {
  userId: string /** VETERINARIAN | PET_OWNER | STAFF */;
  role: string /** role PET_OWNER ise boş string */;
  clinicId: string /** Token'a bağlanır: ExchangeToken'da gelen client_type ile karşılaştırılır */;
  clientType: access.ClientType /** Token'ın taban scope'ları (rıza DEĞİL) */;
  scopes: string[] /** ISO-8601 */;
  issuedAt: string /** ISO-8601 */;
  expiresAt: string;
}

const TOKEN_KEY_PREFIX = 'access:opaque-token:';

const DEFAULT_TOKEN_TTL = 3600;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly defaultTtl: number;

  constructor(private readonly configService: ConfigService) {
    const options: RedisOptions = {
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: Number(this.configService.get<string>('REDIS_PORT', '6379')),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: Number(this.configService.get<string>('REDIS_DB', '0')),
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };

    this.client = new Redis(options);
    this.defaultTtl = Number(
      this.configService.get<string>(
        'OPAQUE_TOKEN_TTL',
        String(DEFAULT_TOKEN_TTL),
      ),
    );

    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis bağlantı hatası: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.client.ping();
    this.logger.log('Redis bağlantısı hazır');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis bağlantısı kapatıldı');
  }

  // ---------- CREATE ----------
  async createTokenRecord(
    opaqueToken: string,
    record: OpaqueTokenRecord,
    ttlSeconds?: number,
  ): Promise<boolean> {
    const ttl = this.resolveTtl(record, ttlSeconds);
    if (ttl <= 0) {
      this.logger.warn(
        `Süresi dolmuş token için kayıt açılmadı (userId=${record.userId})`,
      );
      return false;
    }

    await this.client.set(
      this.tokenKey(opaqueToken),
      JSON.stringify(record),
      'EX',
      ttl,
    );
    return true;
  }

  // ---------- READ ----------
  async getTokenRecord(opaqueToken: string): Promise<OpaqueTokenRecord | null> {
    const key = this.tokenKey(opaqueToken);
    const raw = await this.client.get(key);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as OpaqueTokenRecord;
    } catch {
      this.logger.warn(`Bozuk token kaydı silindi: ${key}`);
      await this.client.del(key);
      return null;
    }
  }

  /** Kayıt var mı — içeriğe ihtiyaç duymayan kontroller için. */
  async hasTokenRecord(opaqueToken: string): Promise<boolean> {
    const count = await this.client.exists(this.tokenKey(opaqueToken));
    return count > 0;
  }

  /** Kalan ömür (saniye). Kayıt yoksa veya TTL'siz ise -1 döner. */
  async getTokenTtl(opaqueToken: string): Promise<number> {
    const ttl = await this.client.ttl(this.tokenKey(opaqueToken));
    return ttl >= 0 ? ttl : -1;
  }

  // ---------- UPDATE ----------
  /**
   * Kaydın alanlarını günceller, TTL'e dokunmaz
   *
   * @returns Güncellenmiş kayıt, kayıt yoksa null.
   */
  async updateTokenRecord(
    opaqueToken: string,
    patch: Partial<OpaqueTokenRecord>,
  ): Promise<OpaqueTokenRecord | null> {
    const current = await this.getTokenRecord(opaqueToken);
    if (current === null) return null;

    const updated: OpaqueTokenRecord = { ...current, ...patch };
    await this.client.set(
      this.tokenKey(opaqueToken),
      JSON.stringify(updated),
      'KEEPTTL',
    );
    return updated;
  }

  /**
   * Kaydın ömrünü uzatır — içeriğe dokunmaz.
   * @returns Kayıt yoksa false.
   */
  async refreshTokenTtl(
    opaqueToken: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (ttlSeconds <= 0) return false;
    const applied = await this.client.expire(
      this.tokenKey(opaqueToken),
      Math.min(ttlSeconds, this.defaultTtl),
    );
    return applied === 1;
  }

  // ---------- DELETE ----------
  /**
   * Kaydı siler — logout ve token iptalinde çağrılır.
   * @returns Silinecek kayıt yoksa false.
   */
  async deleteTokenRecord(opaqueToken: string): Promise<boolean> {
    const deleted = await this.client.del(this.tokenKey(opaqueToken));
    return deleted > 0;
  }

  // ---------- Yardımcılar ----------
  /** Healthcheck için ham bağlantı kontrolü. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * key olarak sha256 özeti kullanılacak.
   */
  private tokenKey(opaqueToken: string): string {
    const digest = createHash('sha256').update(opaqueToken).digest('hex');
    return `${TOKEN_KEY_PREFIX}${digest}`;
  }

  /** Cache, token'ın kendi ömrünü aşamaz; üst sınır defaultTtl. */
  private resolveTtl(record: OpaqueTokenRecord, ttlSeconds?: number): number {
    if (ttlSeconds !== undefined) {
      return Math.min(ttlSeconds, this.defaultTtl);
    }

    const expiresAt = Date.parse(record.expiresAt);
    if (Number.isNaN(expiresAt)) return this.defaultTtl;

    const remaining = Math.floor((expiresAt - Date.now()) / 1000);
    return Math.min(remaining, this.defaultTtl);
  }
}
