import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { runWithCorrelationId } from '@libs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMqService } from './rabbitmq.service';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_MAX_BACKOFF_SECONDS,
  OUTBOX_POLL_INTERVAL_MS,
} from './messaging.constants';

interface ClaimedOutboxRow {
  id: string;
  type: string;
  payload: unknown;
  correlationId: string;
  attempts: number;
}

@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((e) =>
          this.logger.error(
            `Outbox turu başarısız: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
        .finally(() => {
          this.running = undefined;
          this.schedule();
        });
    }, OUTBOX_POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const rows = await this.prisma.$queryRaw<ClaimedOutboxRow[]>`
      UPDATE outbox
      SET next_attempt_at = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS})
      WHERE id IN (
        SELECT id FROM outbox
        WHERE published_at IS NULL AND next_attempt_at <= now()
        ORDER BY created_at, id
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, correlation_id AS "correlationId", attempts`;

    await Promise.all(rows.map((row) => this.publish(row)));
  }

  private publish(row: ClaimedOutboxRow): Promise<void> {
    return runWithCorrelationId(row.correlationId, async () => {
      try {
        await this.rabbit.publish(row);
      } catch (e) {
        await this.postpone(row, e);
        return;
      }

      await this.prisma.outbox.update({
        where: { id: row.id },
        data: { publishedAt: new Date(), lastError: null },
      });
    });
  }

  private async postpone(row: ClaimedOutboxRow, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const delaySeconds = Math.min(2 ** attempts, OUTBOX_MAX_BACKOFF_SECONDS);
    const reason = error instanceof Error ? error.message : String(error);

    await this.prisma.outbox.update({
      where: { id: row.id },
      data: {
        attempts,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: reason.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH),
      },
    });

    this.logger.warn(
      `Olay yayınlanamadı, ${delaySeconds} sn sonra tekrar denenecek (outboxId=${row.id} deneme=${attempts}): ${reason}`,
    );
  }
}
