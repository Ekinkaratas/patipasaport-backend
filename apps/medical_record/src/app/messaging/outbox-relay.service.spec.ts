jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Logger } from '@nestjs/common';
import { getCorrelationId } from '@libs/common';
import { OutboxRelayService } from './outbox-relay.service';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMqService } from './rabbitmq.service';

// ---Amaç: kilitlenip alınan outbox satırını üretmek ---
const claimed = (id: string, attempts = 0) => ({
  id,
  type: 'com.patipasaport.document.uploaded.v1',
  payload: { id, data: { documentId: 'belge-1' } },
  correlationId: `korelasyon-${id}`,
  attempts,
});

describe('OutboxRelayService', () => {
  let relay: OutboxRelayService;
  let prisma: { $queryRaw: jest.Mock; outbox: { update: jest.Mock } };
  let rabbit: { publish: jest.Mock };
  const tick = () => (relay as unknown as { tick(): Promise<void> }).tick();

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      outbox: { update: jest.fn().mockResolvedValue({}) },
    };
    rabbit = { publish: jest.fn().mockResolvedValue(undefined) };
    relay = new OutboxRelayService(
      prisma as unknown as PrismaService,
      rabbit as unknown as RabbitMqService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ---Amaç: satırların çok kopyada çakışmadan kira ile alındığını doğrulamak ---
  it('zamanı gelmiş en fazla 50 satır SKIP LOCKED ve 60 sn kira ile alınır', async () => {
    await tick();
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('published_at IS NULL AND next_attempt_at <= now()');
    expect(sql).toContain('ORDER BY created_at, id');
    expect(values).toEqual([60, 50]);
  });

  // ---Amaç: onaylanan olayın yayınlandı olarak işaretlendiğini ve correlation id ile yayınlandığını doğrulamak ---
  it('yayıncı onayı gelince published_at doldurulur', async () => {
    let seenCorrelation = '';
    rabbit.publish.mockImplementation(async () => {
      seenCorrelation = getCorrelationId();
    });
    prisma.$queryRaw.mockResolvedValue([claimed('o1')]);

    await tick();

    expect(rabbit.publish).toHaveBeenCalledWith(claimed('o1'));
    expect(seenCorrelation).toBe('korelasyon-o1');
    expect(prisma.outbox.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { publishedAt: expect.any(Date), lastError: null },
    });
  });

  // ---Amaç: yayın hatasında deneme sayısının artıp sonraki denemenin üstel olarak ertelendiğini doğrulamak ---
  it.each([
    [0, 2],
    [3, 16],
    [8, 300],
  ])(
    '%i denemeden sonra hata → %i sn sonra tekrar',
    async (attempts, delaySeconds) => {
      const now = Date.now();
      jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
      prisma.$queryRaw.mockResolvedValue([claimed('o1', attempts)]);
      rabbit.publish.mockRejectedValue(new Error('timeout'));

      await tick();

      expect(prisma.outbox.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: {
          attempts: attempts + 1,
          nextAttemptAt: new Date(now + delaySeconds * 1000),
          lastError: 'timeout',
        },
      });
    },
  );

  it('uzun hata mesajı 500 karaktere kısaltılır', async () => {
    prisma.$queryRaw.mockResolvedValue([claimed('o1')]);
    rabbit.publish.mockRejectedValue(new Error('x'.repeat(800)));
    await tick();
    expect(prisma.outbox.update.mock.calls[0][0].data.lastError).toHaveLength(
      500,
    );
  });

  // ---Amaç: bir satırın hatasının diğerlerinin yayınını engellemediğini doğrulamak ---
  it('bir satır başarısız olsa da diğerleri yayınlanır', async () => {
    prisma.$queryRaw.mockResolvedValue([claimed('o1'), claimed('o2')]);
    rabbit.publish.mockImplementation(async (row: { id: string }) => {
      if (row.id === 'o1') throw new Error('hata');
    });

    await tick();

    expect(prisma.outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: expect.objectContaining({ attempts: 1 }),
      }),
    );
    expect(prisma.outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o2' },
        data: expect.objectContaining({ lastError: null }),
      }),
    );
  });

  // ---Amaç: döngünün saniyede bir çalıştığını, hatada durmadığını ve kapanışta durduğunu doğrulamak ---
  describe('zamanlama', () => {
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it('açılıştan 1 sn sonra tur atar, tur bitince bir sonrakini kurar', async () => {
      jest.useFakeTimers();
      relay.onApplicationBootstrap();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      await relay.onModuleDestroy();
    });

    it('tur hata verse de döngü devam eder', async () => {
      jest.useFakeTimers();
      prisma.$queryRaw.mockRejectedValueOnce(new Error('veritabanı kapalı'));
      relay.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(1000);
      await flush();
      await jest.advanceTimersByTimeAsync(1000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      await relay.onModuleDestroy();
    });

    it('kapanışta yeni tur kurulmaz', async () => {
      jest.useFakeTimers();
      relay.onApplicationBootstrap();
      await relay.onModuleDestroy();

      await jest.advanceTimersByTimeAsync(5000);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
