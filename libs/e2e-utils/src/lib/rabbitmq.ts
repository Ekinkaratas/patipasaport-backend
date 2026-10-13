import { ChannelModel, ConfirmChannel, connect, GetMessage } from 'amqplib';
import { randomUUID } from 'crypto';
import { DOCKER_RABBITMQ_PORT } from './ports';
import { requireEnv } from './workspace';

export const EVENTS_EXCHANGE = 'patipasaport.events';
export const AI_UPLOADED_QUEUE = 'ai-service.document-uploaded';
export const DOCUMENT_EVENTS_QUEUE = 'medical-record.document-events';
export const DOCUMENT_EVENTS_DLQ = `${DOCUMENT_EVENTS_QUEUE}.dlq`;

export type AiEventKind = 'processing_started' | 'analyzed' | 'analysis_failed';

const AI_EVENTS: Record<AiEventKind, { type: string; schema: string }> = {
  processing_started: {
    type: 'com.patipasaport.document.processing_started.v1',
    schema: 'urn:patipasaport:events:DocumentProcessingStarted:v1',
  },
  analyzed: {
    type: 'com.patipasaport.document.analyzed.v1',
    schema: 'urn:patipasaport:events:DocumentAnalyzed:v1',
  },
  analysis_failed: {
    type: 'com.patipasaport.document.analysis_failed.v1',
    schema: 'urn:patipasaport:events:DocumentAnalysisFailed:v1',
  },
};

export const messageSubject = (message: GetMessage): string | undefined => {
  try {
    const body = JSON.parse(message.content.toString('utf8')) as {
      subject?: unknown;
    };
    return typeof body.subject === 'string' ? body.subject : undefined;
  } catch {
    return undefined;
  }
};

export class EventBus {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;

  private async open(): Promise<ConfirmChannel> {
    if (!this.channel) {
      this.connection = await connect({
        protocol: 'amqp',
        hostname: '127.0.0.1',
        port: DOCKER_RABBITMQ_PORT,
        username: requireEnv('RABBITMQ_USER'),
        password: requireEnv('RABBITMQ_PASSWORD'),
      });
      this.channel = await this.connection.createConfirmChannel();
    }
    return this.channel;
  }

  async publishRaw(routingKey: string, body: string): Promise<string> {
    const channel = await this.open();
    const messageId = randomUUID();
    channel.publish(EVENTS_EXCHANGE, routingKey, Buffer.from(body), {
      persistent: true,
      contentType: 'application/cloudevents+json',
      messageId,
      headers: { 'x-correlation-id': randomUUID() },
    });
    await channel.waitForConfirms();
    return messageId;
  }

  publishAiEvent(
    kind: AiEventKind,
    data: Record<string, unknown>,
    envelope: Record<string, unknown> = {},
  ): Promise<string> {
    const { type, schema } = AI_EVENTS[kind];
    const event = {
      specversion: '1.0',
      id: randomUUID(),
      source: '/patipasaport/ai-service',
      type,
      subject: data['documentId'],
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      dataschema: schema,
      data,
      ...envelope,
    };
    return this.publishRaw(type, JSON.stringify(event));
  }

  async messageCount(queue: string): Promise<number> {
    const channel = await this.open();
    return (await channel.checkQueue(queue)).messageCount;
  }

  async takeWhere(
    queue: string,
    matches: (message: GetMessage) => boolean,
  ): Promise<GetMessage[]> {
    const channel = await this.open();
    const taken: GetMessage[] = [];
    const kept: GetMessage[] = [];
    for (
      let message = await channel.get(queue, { noAck: false });
      message;
      message = await channel.get(queue, { noAck: false })
    ) {
      (matches(message) ? taken : kept).push(message);
    }
    taken.forEach((message) => channel.ack(message));
    kept.forEach((message) => channel.nack(message, false, true));
    return taken;
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
    this.channel = undefined;
    this.connection = undefined;
  }
}
