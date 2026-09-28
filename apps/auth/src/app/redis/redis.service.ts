import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, RedisOptions } from 'ioredis';
import { rejectRpc, ResponseMessages } from '@libs/common';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const options: RedisOptions = {
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: Number(this.configService.get<string>('REDIS_PORT', '6380')),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: Number(this.configService.get<string>('REDIS_DB', '0')),
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };

    this.client = new Redis(options);

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

  /**
   * Sayacı 1 artırır ve yeni değeri döner. TTL yalnızca anahtar İLK
   * oluştuğunda verilir (EXPIRE NX): sonraki artışlar pencereyi uzatmaz.
   * INCR ve EXPIRE tek MULTI içinde gider; arada kopma TTL'siz anahtar bırakmaz.
   */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.execute('incrementWithTtl', () =>
      this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec(),
    );
    const [incrError, count] = results?.[0] ?? [];
    if (incrError || typeof count !== 'number') {
      rejectRpc(
        this.logger,
        ResponseMessages.SERVICE_UNAVAILABLE,
        `Redis INCR sonucu okunamadı (${key})`,
      );
    }
    return count;
  }

  async get(key: string): Promise<string | null> {
    return this.execute('get', () => this.client.get(key));
  }

  async setWithTtl(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.execute('setWithTtl', () =>
      this.client.set(key, value, 'EX', ttlSeconds),
    );
  }

  /** Var olan anahtarın TTL'ini yeniler; anahtar yoksa hiçbir şey yapmaz (false). */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const updated = await this.execute('expire', () =>
      this.client.expire(key, ttlSeconds),
    );
    return updated === 1;
  }

  /** Kalan süre (sn). Anahtar yoksa -2, TTL'siz ise -1 (Redis TTL semantiği). */
  async ttl(key: string): Promise<number> {
    return this.execute('ttl', () => this.client.ttl(key));
  }

  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.execute('delete', () => this.client.del(...keys));
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
   * Redis erişilemiyorsa 500 yerine SERVICE_UNAVAILABLE döner: geçici,
   * yeniden denenebilir. Hata metni yalnızca sunucu logunda kalır.
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
}
