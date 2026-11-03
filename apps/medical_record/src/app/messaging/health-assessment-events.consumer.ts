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
  HEALTH_ASSESSMENT_EVENT_TYPES,
  parseCloudEvent,
} from '@libs/common';
import { events } from '@libs/proto';
import { PrismaService } from '../prisma/prisma.service';
import { HealthAssessmentStatus, Prisma } from '../../generated/prisma/client';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import { validateHealthAssessment } from './health-assessment-content';
import {
  FAILURE_REASON_MAX_LENGTH,
  HEALTH_ASSESSMENT_EVENTS_QUEUE,
  INVALID_AI_OUTPUT,
  MODEL_VERSION_MAX_LENGTH,
} from './messaging.constants';
import { HEALTH_RISK_LEVEL_TO_DB } from '../health-assessment.mapper';

@Injectable()
export class HealthAssessmentEventsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(HealthAssessmentEventsConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit
      .consume(HEALTH_ASSESSMENT_EVENTS_QUEUE, (message) =>
        this.handle(message),
      )
      .catch((e) =>
        this.logger.error(
          `Tüketici başlatılamadı (queue=${HEALTH_ASSESSMENT_EVENTS_QUEUE}): ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.rabbit.cancelConsumers();
  }

  async handle(message: ConsumeMessage): Promise<void> {
    const event = HealthAssessmentEventsConsumer.parse(message);

    switch (event.type) {
      case HEALTH_ASSESSMENT_EVENT_TYPES.GENERATED:
        return this.onGenerated(event);
      case HEALTH_ASSESSMENT_EVENT_TYPES.FAILED:
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

  private static requestIdOf(event: CloudEvent, requestId: string): string {
    if (!isUUID(requestId, '4') || requestId !== event.subject) {
      throw new InvalidEventError(
        `request_id geçersiz ya da subject ile uyuşmuyor (eventId=${event.id})`,
      );
    }
    return requestId;
  }

  private logIgnored(event: CloudEvent, requestId: string): void {
    this.logger.log(
      `Olay yok sayıldı, istek güncel değil ya da sonuçlanmış (type=${event.type} requestId=${requestId})`,
    );
  }

  private async onGenerated(event: CloudEvent): Promise<void> {
    const { assessment, ...fields } = event.data as Record<string, unknown>;
    const data = events.HealthAssessmentGenerated.fromJSON(fields);
    const requestId = HealthAssessmentEventsConsumer.requestIdOf(
      event,
      data.requestId,
    );

    if (
      !data.modelVersion ||
      data.modelVersion.length > MODEL_VERSION_MAX_LENGTH
    ) {
      throw new InvalidEventError(
        `model_version boş ya da ${MODEL_VERSION_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }

    const row = await this.prisma.healthAssessment.findUnique({
      where: { requestId },
      select: { status: true, basedOnRecordIds: true },
    });
    if (!row || row.status !== HealthAssessmentStatus.PENDING) {
      this.logIgnored(event, requestId);
      return;
    }

    const labResults = await this.prisma.labResult.findMany({
      where: { recordId: { in: row.basedOnRecordIds } },
      select: { testName: true },
    });
    const content = validateHealthAssessment(
      assessment,
      data.confidence,
      new Set(labResults.map((item) => item.testName.trim())),
    );

    const moved = await this.prisma.healthAssessment.updateMany({
      where: { requestId, status: HealthAssessmentStatus.PENDING },
      data: content
        ? {
            status: HealthAssessmentStatus.READY,
            summary: content.summary,
            riskLevel: HEALTH_RISK_LEVEL_TO_DB[content.riskLevel],
            payload: content.payload as Prisma.InputJsonObject,
            confidence: content.confidence,
            modelVersion: data.modelVersion,
            generatedAt: new Date(),
          }
        : {
            status: HealthAssessmentStatus.FAILED,
            failureReason: INVALID_AI_OUTPUT,
            modelVersion: data.modelVersion,
          },
    });

    if (moved.count === 0) {
      this.logIgnored(event, requestId);
      return;
    }
    if (!content) {
      this.logger.warn(
        `Sağlık değerlendirmesi kurallara uymuyor, satır FAILED yapıldı (requestId=${requestId} eventId=${event.id})`,
      );
    }
  }

  private async onFailed(event: CloudEvent): Promise<void> {
    const data = events.HealthAssessmentFailed.fromJSON(event.data);
    const requestId = HealthAssessmentEventsConsumer.requestIdOf(
      event,
      data.requestId,
    );

    if (!data.errorCode || data.errorCode.length > FAILURE_REASON_MAX_LENGTH) {
      throw new InvalidEventError(
        `error_code boş ya da ${FAILURE_REASON_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }

    const moved = await this.prisma.healthAssessment.updateMany({
      where: { requestId, status: HealthAssessmentStatus.PENDING },
      data: {
        status: HealthAssessmentStatus.FAILED,
        failureReason: data.errorCode,
      },
    });

    if (moved.count === 0) {
      this.logIgnored(event, requestId);
    }
  }
}
