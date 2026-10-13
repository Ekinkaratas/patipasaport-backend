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
  DOCUMENT_EVENT_TYPES,
  parseCloudEvent,
} from '@libs/common';
import { events } from '@libs/proto';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentStatus, Prisma } from '../../generated/prisma/client';
import { RECORD_TYPE_TO_DB } from '../medical-record.mapper';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import {
  DOCUMENT_EVENTS_QUEUE,
  FAILURE_REASON_MAX_LENGTH,
  MODEL_VERSION_MAX_LENGTH,
} from './messaging.constants';

const OPEN_STATUSES: DocumentStatus[] = [
  DocumentStatus.QUEUED,
  DocumentStatus.PROCESSING,
];

@Injectable()
export class DocumentEventsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DocumentEventsConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit
      .consume(DOCUMENT_EVENTS_QUEUE, (message) => this.handle(message))
      .catch((e) =>
        this.logger.error(
          `Tüketici başlatılamadı (queue=${DOCUMENT_EVENTS_QUEUE}): ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.rabbit.cancelConsumers();
  }

  async handle(message: ConsumeMessage): Promise<void> {
    const event = DocumentEventsConsumer.parse(message);

    switch (event.type) {
      case DOCUMENT_EVENT_TYPES.PROCESSING_STARTED:
        return this.onProcessingStarted(event);
      case DOCUMENT_EVENT_TYPES.ANALYZED:
        return this.onAnalyzed(event);
      case DOCUMENT_EVENT_TYPES.ANALYSIS_FAILED:
        return this.onAnalysisFailed(event);
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

  private static documentIdOf(event: CloudEvent, documentId: string): string {
    if (!isUUID(documentId, '4') || documentId !== event.subject) {
      throw new InvalidEventError(
        `document_id geçersiz ya da subject ile uyuşmuyor (eventId=${event.id})`,
      );
    }
    return documentId;
  }

  private async rejectIfDocumentMissing(
    documentId: string,
    event: CloudEvent,
  ): Promise<void> {
    const exists = await this.prisma.document.count({
      where: { id: documentId },
    });
    if (exists === 0) {
      throw new InvalidEventError(
        `belge bulunamadı (documentId=${documentId} eventId=${event.id})`,
      );
    }
    this.logger.log(
      `Olay yok sayıldı, belge zaten bu aşamayı geçmiş (type=${event.type} documentId=${documentId})`,
    );
  }

  private async onProcessingStarted(event: CloudEvent): Promise<void> {
    const data = events.DocumentProcessingStarted.fromJSON(event.data);
    const documentId = DocumentEventsConsumer.documentIdOf(
      event,
      data.documentId,
    );

    const moved = await this.prisma.document.updateMany({
      where: { id: documentId, status: DocumentStatus.QUEUED },
      data: { status: DocumentStatus.PROCESSING },
    });

    if (moved.count === 0) {
      await this.rejectIfDocumentMissing(documentId, event);
    }
  }

  private async onAnalyzed(event: CloudEvent): Promise<void> {
    const data = events.DocumentAnalyzed.fromJSON(event.data);
    const documentId = DocumentEventsConsumer.documentIdOf(
      event,
      data.documentId,
    );
    const recordType = data.proposal
      ? RECORD_TYPE_TO_DB[data.proposal.type]
      : undefined;

    if (!data.proposal || !recordType) {
      throw new InvalidEventError(
        `öneri yok ya da kayıt türü geçersiz (eventId=${event.id})`,
      );
    }
    if (
      !data.modelVersion ||
      data.modelVersion.length > MODEL_VERSION_MAX_LENGTH
    ) {
      throw new InvalidEventError(
        `model_version boş ya da ${MODEL_VERSION_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }
    if (
      !Number.isFinite(data.confidence) ||
      data.confidence < 0 ||
      data.confidence > 1
    ) {
      throw new InvalidEventError(
        `confidence 0-1 aralığında değil (eventId=${event.id})`,
      );
    }

    const proposal = JSON.parse(
      JSON.stringify(data.proposal),
    ) as Prisma.InputJsonObject;

    let created = false;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const document = await tx.document.findUnique({
          where: { id: documentId },
          select: { petId: true, clinicId: true },
        });
        if (!document) {
          throw new InvalidEventError(
            `belge bulunamadı (documentId=${documentId} eventId=${event.id})`,
          );
        }

        const moved = await tx.document.updateMany({
          where: { id: documentId, status: { in: OPEN_STATUSES } },
          data: { status: DocumentStatus.DRAFT_READY },
        });
        if (moved.count === 0) return false;

        await tx.draftReview.create({
          data: {
            documentId,
            petId: document.petId,
            clinicId: document.clinicId,
            recordType,
            proposedPayload: proposal,
            modelVersion: data.modelVersion,
            confidence: data.confidence,
          },
        });
        return true;
      });
    } catch (e) {
      if (
        !(
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
      ) {
        throw e;
      }
    }

    if (!created) {
      this.logger.log(
        `Olay yok sayıldı, belgenin taslağı zaten var ya da belge kapanmış (documentId=${documentId})`,
      );
    }
  }

  private async onAnalysisFailed(event: CloudEvent): Promise<void> {
    const data = events.DocumentAnalysisFailed.fromJSON(event.data);
    const documentId = DocumentEventsConsumer.documentIdOf(
      event,
      data.documentId,
    );

    if (!data.errorCode || data.errorCode.length > FAILURE_REASON_MAX_LENGTH) {
      throw new InvalidEventError(
        `error_code boş ya da ${FAILURE_REASON_MAX_LENGTH} karakterden uzun (eventId=${event.id})`,
      );
    }

    const moved = await this.prisma.document.updateMany({
      where: { id: documentId, status: { in: OPEN_STATUSES } },
      data: { status: DocumentStatus.FAILED, failureReason: data.errorCode },
    });

    if (moved.count === 0) {
      await this.rejectIfDocumentMissing(documentId, event);
    }
  }
}
