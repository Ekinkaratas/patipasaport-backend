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
import { rejectRpc, ResponseMessages } from '@libs/common';

/**
 * Kayıt HER ZAMAN TTL'li yazılır — opaque token'ın kendi ömrünü asla aşmaz.
 */
export interface OpaqueTokenRecord {
  userId: string;
  /** CLINIC | PET_OWNER */
  role: string;
  /** role PET_OWNER ise boş string */
  clinicId: string;
  /** Token'a bağlanır: ExchangeToken'da gelen client_type ile karşılaştırılır */
  clientType: access.ClientType;
  /** ISO-8601 */
  issuedAt: string;
  /** ISO-8601 */
  expiresAt: string;
}

/** Kayıt oluşturulurken zaman alanları HENÜZ bilinmez; onları bu katman üretir. */
export type NewOpaqueTokenRecord = Omit<
  OpaqueTokenRecord,
  'issuedAt' | 'expiresAt'
>;

/** Gerçekten uygulanan süre bilgisi — çağıranın cevabı buradan kurulur. */
export interface CreatedTokenInfo {
  ttlSeconds: number;
  issuedAt: string;
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
      host: this.configService.getOrThrow<string>('REDIS_HOST'),
      port: Number(this.configService.get<string>('REDIS_PORT', '6379')),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: Number(this.configService.get<string>('REDIS_DB', '0')),
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };

    this.client = new Redis(options);
    this.defaultTtl = this.resolveDefaultTtl();

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
    record: NewOpaqueTokenRecord,
    ttlSeconds?: number,
  ): Promise<CreatedTokenInfo> {
    this.logger.log('istek createTokenRecord metoduna geldi');
    const requested = RedisService.isPositiveTtl(ttlSeconds)
      ? ttlSeconds
      : this.defaultTtl;
    const ttl = Math.min(requested, this.defaultTtl);

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

    this.logger.log(
      'createTokenRecord: OpaqueTokenRecord değişkeni tanımlandı',
    );
    const stored: OpaqueTokenRecord = {
      ...record,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.logger.log('createTokenRecord: redis yazma işlemi başladı');
    await this.execute('createTokenRecord', () =>
      this.client.set(
        this.tokenKey(opaqueToken),
        JSON.stringify(stored),
        'EX',
        ttl,
      ),
    );

    this.logger.log('createTokenRecord: başarıyla tanımlandı');
    return {
      ttlSeconds: ttl,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
    };
  }

  // ---------- READ ----------
  async getTokenRecord(opaqueToken: string): Promise<OpaqueTokenRecord | null> {
    this.logger.log('istek getTokenRecord metoduna geldi');

    const key = this.tokenKey(opaqueToken);

    const raw = await this.execute('getTokenRecord', () =>
      this.client.get(key),
    );
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Bozuk JSON içeren token kaydı silindi: ${key}`);
      await this.execute('getTokenRecord:del', () => this.client.del(key));
      return null;
    }

    if (!RedisService.isOpaqueTokenRecord(parsed)) {
      this.logger.warn(`Şekli bozuk token kaydı silindi: ${key}`);
      await this.execute('getTokenRecord:del', () => this.client.del(key));
      return null;
    }

    this.logger.log('getTokenRecord: başarıyla tanımlandı');
    return parsed;
  }

  /** Kayıt var mı — içeriğe ihtiyaç duymayan kontroller için. */
  async hasTokenRecord(opaqueToken: string): Promise<boolean> {
    const count = await this.execute('hasTokenRecord', () =>
      this.client.exists(this.tokenKey(opaqueToken)),
    );
    return count > 0;
  }

  /** Kalan ömür (saniye). Kayıt yoksa veya TTL'siz ise -1 döner. */
  async getTokenTtl(opaqueToken: string): Promise<number> {
    const ttl = await this.execute('getTokenTtl', () =>
      this.client.ttl(this.tokenKey(opaqueToken)),
    );
    return ttl >= 0 ? ttl : -1;
  }

  // ---------- UPDATE ----------
  /**
   * Kaydın kimlik alanlarını günceller, TTL'e dokunmaz.
   * issuedAt/expiresAt bilinçli olarak güncellenemez: Redis anahtarının
   * ömrüyle kayıttaki tarih ayrışırsa introspect hatalı karar verir.
   *
   * @returns Güncellenmiş kayıt, kayıt yoksa null.
   */
  async updateTokenRecord(
    opaqueToken: string,
    patch: Partial<NewOpaqueTokenRecord>,
  ): Promise<OpaqueTokenRecord | null> {
    this.logger.log('istek updateTokenRecord metoduna geldi');
    const current = await this.getTokenRecord(opaqueToken);
    if (current === null) return null;

    this.logger.log('updateTokenRecord: güncelleme işlemi başladı');
    const updated: OpaqueTokenRecord = { ...current, ...patch };
    await this.execute('updateTokenRecord', () =>
      this.client.set(
        this.tokenKey(opaqueToken),
        JSON.stringify(updated),
        'KEEPTTL',
      ),
    );

    this.logger.log('updateTokenRecord: başarıyla tanımlandı');
    return updated;
  }

  /**
   * Kaydın ömrünü uzatır. Anahtarın TTL'i ile kayıttaki expiresAt TEK
   * işlemde birlikte yazılır; ayrışırlarsa introspect, Redis'in hâlâ canlı
   * saydığı bir token'ı süresi geçmiş sanıp reddeder.
   * @returns Uygulanan süre bilgisi, kayıt yoksa null.
   */
  async refreshTokenTtl(
    opaqueToken: string,
    ttlSeconds: number,
  ): Promise<CreatedTokenInfo | null> {
    this.logger.log('istek refreshTokenTtl metoduna geldi');
    if (!RedisService.isPositiveTtl(ttlSeconds)) return null;

    const current = await this.getTokenRecord(opaqueToken);
    if (current === null) return null;

    const ttl = Math.min(ttlSeconds, this.defaultTtl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const updated: OpaqueTokenRecord = { ...current, expiresAt };

    await this.execute('refreshTokenTtl', () =>
      this.client.set(
        this.tokenKey(opaqueToken),
        JSON.stringify(updated),
        'EX',
        ttl,
      ),
    );

    this.logger.log('updateTokenRecord: başarıyla tanımlandı');
    return { ttlSeconds: ttl, issuedAt: updated.issuedAt, expiresAt };
  }

  // ---------- DELETE ----------
  /**
   * Kaydı siler — logout ve token iptalinde çağrılır.
   * @returns Silinecek kayıt yoksa false.
   */
  async deleteTokenRecord(opaqueToken: string): Promise<boolean> {
    const deleted = await this.execute('deleteTokenRecord', () =>
      this.client.del(this.tokenKey(opaqueToken)),
    );
    return deleted > 0;
  }

  // ---------- Yardımcılar ----------
  /**
   * Her Redis çağrısını sarar.
   *
   * depo erişilemiyorsa 500 hata yerine SERVICE_UNAVAILABLE geri döndürmeye yarar:
   * geçici, yeniden denenebilir ve bizim tarafımızdaki bir arıza statüsüne girer.
   *
   * Hatanın metni yalnızca sunucu logunda kalır; istemci kodu görür.
   */
  private async execute<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      rejectRpc(
        this.logger,
        ResponseMessages.SERVICE_UNAVAILABLE,
        `Redis işlemi başarısız (${operation}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Healthcheck için ham bağlantı kontrolü. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * OPAQUE_TOKEN_TTL yanlış yazılırsa (ör. "3600s") Number() NaN döner;
   * bu NaN Redis'e EX olarak gider ve token üretimi anlaşılmaz bir
   * RangeError ile ölür. Geçersiz değer sessizce yutulmaz, loglanır.
   */
  private resolveDefaultTtl(): number {
    const raw = this.configService.get<string>('OPAQUE_TOKEN_TTL');
    if (raw === undefined) return DEFAULT_TOKEN_TTL;

    const parsed = Number(raw);
    if (!RedisService.isPositiveTtl(parsed)) {
      this.logger.warn(
        `OPAQUE_TOKEN_TTL geçersiz ("${raw}") — varsayılan ${DEFAULT_TOKEN_TTL} sn kullanılıyor`,
      );
      return DEFAULT_TOKEN_TTL;
    }
    return parsed;
  }

  private static isPositiveTtl(value: number | undefined): value is number {
    return value !== undefined && Number.isInteger(value) && value > 0;
  }

  private static isOpaqueTokenRecord(
    value: unknown,
  ): value is OpaqueTokenRecord {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    return (
      typeof r['userId'] === 'string' &&
      typeof r['role'] === 'string' &&
      typeof r['clinicId'] === 'string' &&
      typeof r['clientType'] === 'number' &&
      typeof r['issuedAt'] === 'string' &&
      typeof r['expiresAt'] === 'string'
    );
  }

  /**
   * key olarak sha256 özeti kullanılacak.
   */
  private tokenKey(opaqueToken: string): string {
    const digest = createHash('sha256').update(opaqueToken).digest('hex');
    return `${TOKEN_KEY_PREFIX}${digest}`;
  }
}
