import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  CLOUD_EVENT_CONTENT_TYPE,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_UNKNOWN,
  DOCUMENT_EVENT_TYPES,
  runWithCorrelationId,
} from '@libs/common';
import {
  AI_UPLOADED_QUEUE,
  CONSUMER_PREFETCH,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE_SUFFIX,
  DOCUMENT_EVENTS_QUEUE,
  EVENTS_EXCHANGE,
  MAX_DELIVERY_ATTEMPTS,
  PUBLISH_TIMEOUT_MS,
  RETRY_COUNT_HEADER,
  RETRY_DELAY_MS,
  RETRY_QUEUE_SUFFIX,
} from './messaging.constants';

export class InvalidEventError extends Error {}

export interface OutgoingEvent {
  id: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

const QUEUE_BINDINGS: Record<string, string[]> = {
  [AI_UPLOADED_QUEUE]: [DOCUMENT_EVENT_TYPES.UPLOADED],
  [DOCUMENT_EVENTS_QUEUE]: [
    DOCUMENT_EVENT_TYPES.PROCESSING_STARTED,
    DOCUMENT_EVENT_TYPES.ANALYZED,
    DOCUMENT_EVENT_TYPES.ANALYSIS_FAILED,
  ],
};

const deadLetterTo = (routingKey: string) => ({
  'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
  'x-dead-letter-routing-key': routingKey,
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
});

async function assertTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', {
    durable: true,
  });

  for (const [queue, routingKeys] of Object.entries(QUEUE_BINDINGS)) {
    const retryQueue = `${queue}${RETRY_QUEUE_SUFFIX}`;
    const deadLetterQueue = `${queue}${DEAD_LETTER_QUEUE_SUFFIX}`;

    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', ...deadLetterTo(deadLetterQueue) },
    });
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': RETRY_DELAY_MS,
        ...deadLetterTo(queue),
      },
    });
    await channel.assertQueue(deadLetterQueue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });

    for (const routingKey of routingKeys) {
      await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
    }
    for (const target of [queue, retryQueue, deadLetterQueue]) {
      await channel.bindQueue(target, DEAD_LETTER_EXCHANGE, target);
    }
  }
}

@Injectable()
export class RabbitMqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection!: AmqpConnectionManager;
  private publisher!: ChannelWrapper;
  private consumer!: ChannelWrapper;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = amqp.connect(
      [
        {
          protocol: 'amqp',
          hostname: this.config.getOrThrow<string>('RABBITMQ_HOST'),
          port: Number(this.config.get<string>('RABBITMQ_PORT', '5672')),
          username: this.config.getOrThrow<string>('RABBITMQ_USER'),
          password: this.config.getOrThrow<string>('RABBITMQ_PASSWORD'),
        },
      ],
      {
        connectionOptions: {
          clientProperties: { connection_name: 'medical-record' },
        },
      },
    );
    this.connection.on('connect', () =>
      this.logger.log('RabbitMQ bağlantısı kuruldu'),
    );
    this.connection.on('connectFailed', ({ err }) =>
      this.logger.warn(`RabbitMQ'ya bağlanılamadı: ${err?.message}`),
    );
    this.connection.on('disconnect', ({ err }) =>
      this.logger.warn(`RabbitMQ bağlantısı koptu: ${err?.message}`),
    );

    this.publisher = this.connection.createChannel({
      name: 'publisher',
      confirm: true,
      setup: assertTopology,
    });
    this.consumer = this.connection.createChannel({
      name: 'consumer',
      confirm: true,
      setup: assertTopology,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection?.close();
  }

  async publish(event: OutgoingEvent): Promise<void> {
    await this.publisher.publish(
      EVENTS_EXCHANGE,
      event.type,
      Buffer.from(JSON.stringify(event.payload)),
      {
        persistent: true,
        contentType: CLOUD_EVENT_CONTENT_TYPE,
        messageId: event.id,
        type: event.type,
        headers: { [CORRELATION_ID_HEADER]: event.correlationId },
        timeout: PUBLISH_TIMEOUT_MS,
      },
    );
  }

  async consume(
    queue: string,
    handler: (message: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    await this.consumer.consume(
      queue,
      (message) => void this.dispatch(queue, message, handler),
      { prefetch: CONSUMER_PREFETCH },
    );
  }

  async cancelConsumers(): Promise<void> {
    await this.consumer?.cancelAll();
  }

  private dispatch(
    queue: string,
    message: ConsumeMessage,
    handler: (message: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    const headers = message.properties.headers ?? {};
    const correlationId =
      typeof headers[CORRELATION_ID_HEADER] === 'string'
        ? headers[CORRELATION_ID_HEADER]
        : CORRELATION_ID_UNKNOWN;

    return runWithCorrelationId(correlationId, async () => {
      try {
        await handler(message);
        this.consumer.ack(message);
      } catch (e) {
        await this.reject(queue, message, e);
      }
    });
  }

  private async reject(
    queue: string,
    message: ConsumeMessage,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const messageId = message.properties.messageId ?? 'yok';

    if (error instanceof InvalidEventError) {
      this.logger.error(
        `Geçersiz mesaj DLQ'ya gönderildi (queue=${queue} messageId=${messageId}): ${reason}`,
      );
      this.consumer.nack(message, false, false);
      return;
    }

    const headers = message.properties.headers ?? {};
    const attempt = (Number(headers[RETRY_COUNT_HEADER]) || 0) + 1;

    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      this.logger.error(
        `Mesaj ${attempt}. denemede de işlenemedi, DLQ'ya gönderildi (queue=${queue} messageId=${messageId}): ${reason}`,
      );
      this.consumer.nack(message, false, false);
      return;
    }

    try {
      await this.consumer.publish(
        DEAD_LETTER_EXCHANGE,
        `${queue}${RETRY_QUEUE_SUFFIX}`,
        message.content,
        {
          persistent: true,
          contentType: message.properties.contentType,
          messageId: message.properties.messageId,
          type: message.properties.type,
          headers: { ...headers, [RETRY_COUNT_HEADER]: attempt },
          timeout: PUBLISH_TIMEOUT_MS,
        },
      );
      this.consumer.ack(message);
      this.logger.warn(
        `Mesaj işlenemedi, ${RETRY_DELAY_MS / 1000} sn sonra tekrar denenecek (deneme=${attempt} queue=${queue} messageId=${messageId}): ${reason}`,
      );
    } catch (publishError) {
      this.logger.error(
        `Tekrar deneme kuyruğuna yazılamadı, mesaj kuyruğa geri bırakıldı (queue=${queue} messageId=${messageId}): ${publishError instanceof Error ? publishError.message : String(publishError)}`,
      );
      this.consumer.nack(message, false, true);
    }
  }
}
