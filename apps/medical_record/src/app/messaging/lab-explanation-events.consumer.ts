import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { isUUID } from 'class-validator';
import {
  CloudEvent,
  LAB_EXPLANATION_EVENT_TYPES,
  parseCloudEvent,
} from '@libs/common';
import { events } from '@libs/proto';
import { PrismaService } from '../prisma/prisma.service';
import { LabExplanationStatus, Prisma } from '../../generated/prisma/client';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import { validateLabExplanation } from './lab-explanation-content';
import {
  FAILURE_REASON_MAX_LENGTH,
  INVALID_AI_OUTPUT,
  LAB_EXPLANATION_EVENTS_QUEUE,
  MODEL_VERSION_MAX_LENGTH,
} from './messaging.constants';

@Injectable()
export class LabExplanationEventsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LabExplanationEventsConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit
      .consume(LAB_EXPLANATION_EVENTS_QUEUE, (message) => this.handle(message))
      .catch((e) =>
        this.logger.error(
          `Tüketici başlatılamadı (queue=${LAB_EXPLANATION_EVENTS_QUEUE}): ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.rabbit.cancelConsumers();
  }

  async handle(message: ConsumeMessage): Promise<void> {
    const event = LabExplanationEventsConsumer.parse(message);

    switch (event.type) {
      case LAB_EXPLANATION_EVENT_TYPES.GENERATED:
        return this.onGenerated(event);
      case LAB_EXPLANATION_EVENT_TYPES.FAILED:
        return this.onFailed(event);
      default:
        throw new InvalidEventError(`beklenmeyen olay türü (${event.type})`);
    }
  }

  private static parse(message: ConsumeMessage): CloudEvent {
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString('utf8'));
    } catch {
      throw new InvalidEventError('gövde JSON değil');
    }

    const event = parseCloudEvent(body);
    if (!event) {
      throw new InvalidEventError('CloudEvents zarfı geçersiz');
    }
    return event;
  }

  private static recordIdOf(event: CloudEvent, recordId: string): string {
    if (!isUUID(recordId, '4') || recordId !== event.subject) {
      throw new InvalidEventError(
        `record_id geçersiz ya da subject ile uyuşmuyor (eventId=${event.id})`,
      );
    }
    return recordId;
  }

  private logIgnored(event: CloudEvent, recordId: string): void {
    this.logger.log(
      `Olay yok sayıldı, tahlil açıklaması zaten sonuçlanmış (type=${event.type} recordId=${recordId})`,
    );
  }

  private async rejectIfExplanationMissing(
    recordId: string,
    event: CloudEvent,
  ): Promise<void> {
    const exists = await this.prisma.labResultExplanation.count({
      where: { recordId },
    });
    if (exists === 0) {
      throw new InvalidEventError(
        `tahlil açıklaması satırı bulunamadı (recordId=${recordId} eventId=${event.id})`,
      );
    }
    this.logIgnored(event, recordId);
  }

  private async onGenerated(event: CloudEvent): Promise<void> {
    const { explanation, ...fields } = event.data as Record<string, unknown>;
    const data = events.LabExplanationGenerated.fromJSON(fields);
    const recordId = LabExplanationEventsConsumer.recordIdOf(
      event,
      data.recordId,
    );

    if (
      !data.modelVersion ||
      data.modelVersion.length > MODEL_VERSION_MAX_LENGTH
    ) {
      throw new InvalidEventError(
        `model_version boş ya da ${MODEL_VERSION_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }

    const row = await this.prisma.labResultExplanation.findUnique({
      where: { recordId },
      select: {
        status: true,
        record: { select: { labResults: { select: { testName: true } } } },
      },
    });
    if (!row) {
      throw new InvalidEventError(
        `tahlil açıklaması satırı bulunamadı (recordId=${recordId} eventId=${event.id})`,
      );
    }
    if (row.status !== LabExplanationStatus.PENDING) {
      this.logIgnored(event, recordId);
      return;
    }

    const content = validateLabExplanation(
      explanation,
      data.confidence,
      new Set(row.record.labResults.map((item) => item.testName)),
    );

    const moved = await this.prisma.labResultExplanation.updateMany({
      where: { recordId, status: LabExplanationStatus.PENDING },
      data: content
        ? {
            status: LabExplanationStatus.READY,
            summary: content.summary,
            items: content.items as unknown as Prisma.InputJsonArray,
            confidence: content.confidence,
            modelVersion: data.modelVersion,
            generatedAt: new Date(),
          }
        : {
            status: LabExplanationStatus.FAILED,
            failureReason: INVALID_AI_OUTPUT,
            modelVersion: data.modelVersion,
          },
    });

    if (moved.count === 0) {
      this.logIgnored(event, recordId);
      return;
    }
    if (!content) {
      this.logger.warn(
        `Tahlil açıklaması kurallara uymuyor, satır FAILED yapıldı (recordId=${recordId} eventId=${event.id})`,
      );
    }
  }

  private async onFailed(event: CloudEvent): Promise<void> {
    const data = events.LabExplanationFailed.fromJSON(event.data);
    const recordId = LabExplanationEventsConsumer.recordIdOf(
      event,
      data.recordId,
    );

    if (!data.errorCode || data.errorCode.length > FAILURE_REASON_MAX_LENGTH) {
      throw new InvalidEventError(
        `error_code boş ya da ${FAILURE_REASON_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }

    const moved = await this.prisma.labResultExplanation.updateMany({
      where: { recordId, status: LabExplanationStatus.PENDING },
      data: {
        status: LabExplanationStatus.FAILED,
        failureReason: data.errorCode,
      },
    });

    if (moved.count === 0) {
      await this.rejectIfExplanationMissing(recordId, event);
    }
  }
}
