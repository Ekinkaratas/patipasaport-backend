const connectMock = jest.fn();
jest.mock('amqp-connection-manager', () => ({
  __esModule: true,
  default: { connect: (...args: unknown[]) => connectMock(...args) },
}));

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { getCorrelationId } from '@libs/common';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';

const QUEUE = 'medical-record.document-events';

// ---Amaç: amqp-connection-manager kanal sarmalayıcısını taklit etmek ---
const channelWrapper = () => ({
  publish: jest.fn().mockResolvedValue(undefined),
  consume: jest.fn().mockResolvedValue(undefined),
  ack: jest.fn(),
  nack: jest.fn(),
  cancelAll: jest.fn().mockResolvedValue(undefined),
});

// ---Amaç: kuyruktan gelen mesajı başlıklarıyla üretmek ---
const consumed = (headers: Record<string, unknown> = {}) =>
  ({
    content: Buffer.from('{"a":1}'),
    properties: {
      headers,
      messageId: 'mesaj-1',
      type: 'com.patipasaport.document.analyzed.v1',
      contentType: 'application/cloudevents+json',
    },
    fields: {},
  }) as unknown as ConsumeMessage;

describe('RabbitMqService', () => {
  let service: RabbitMqService;
  let connection: { on: jest.Mock; createChannel: jest.Mock; close: jest.Mock };
  let publisher: ReturnType<typeof channelWrapper>;
  let consumer: ReturnType<typeof channelWrapper>;
  const env: Record<string, string> = {
    RABBITMQ_HOST: 'rabbitmq',
    RABBITMQ_PORT: '5672',
    RABBITMQ_USER: 'kullanici',
    RABBITMQ_PASSWORD: 'p@ss/w#rd',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    publisher = channelWrapper();
    consumer = channelWrapper();
    connection = {
      on: jest.fn(),
      createChannel: jest
        .fn()
        .mockReturnValueOnce(publisher)
        .mockReturnValueOnce(consumer),
      close: jest.fn().mockResolvedValue(undefined),
    };
    connectMock.mockReset().mockReturnValue(connection);
    const config = {
      getOrThrow: (key: string) => env[key],
      get: (key: string, fallback?: string) => env[key] ?? fallback,
    } as unknown as ConfigService;
    service = new RabbitMqService(config);
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  // ---Amaç: bağlantının URL kurmadan ayrı alanlarla açıldığını ve iki onaylı kanal oluşturulduğunu doğrulamak ---
  it("özel karakterli şifre URL'ye girmeden bağlanır, iki onaylı kanal açılır", () => {
    expect(connectMock).toHaveBeenCalledWith(
      [
        {
          protocol: 'amqp',
          hostname: 'rabbitmq',
          port: 5672,
          username: 'kullanici',
          password: 'p@ss/w#rd',
        },
      ],
      {
        connectionOptions: {
          clientProperties: { connection_name: 'medical-record' },
        },
      },
    );
    expect(connection.createChannel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'publisher', confirm: true }),
    );
    expect(connection.createChannel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'consumer', confirm: true }),
    );
  });

  it('kapanışta bağlantı kapatılır', async () => {
    await service.onApplicationShutdown();
    expect(connection.close).toHaveBeenCalled();
  });

  // ---Amaç: her yeniden bağlanmada kurulan topolojinin sözleşmeyle birebir aynı olduğunu doğrulamak ---
  describe('topoloji', () => {
    let channel: {
      assertExchange: jest.Mock;
      assertQueue: jest.Mock;
      bindQueue: jest.Mock;
    };

    beforeEach(async () => {
      channel = {
        assertExchange: jest.fn(),
        assertQueue: jest.fn(),
        bindQueue: jest.fn(),
      };
      const [{ setup }] = connection.createChannel.mock.calls[0];
      await setup(channel as unknown as ConfirmChannel);
    });

    it('iki kanal da aynı topoloji kurulumunu kullanır', () => {
      expect(connection.createChannel.mock.calls[0][0].setup).toBe(
        connection.createChannel.mock.calls[1][0].setup,
      );
    });

    it("exchange'ler kalıcıdır: olaylar topic, dead-letter direct", () => {
      expect(channel.assertExchange).toHaveBeenCalledWith(
        'patipasaport.events',
        'topic',
        { durable: true },
      );
      expect(channel.assertExchange).toHaveBeenCalledWith(
        'patipasaport.events.dlx',
        'direct',
        { durable: true },
      );
    });

    it.each(['ai-service.document-uploaded', QUEUE])(
      '%s ve retry/dlq kuyrukları quorum ve doğru argümanlarla tanımlanır',
      (queue) => {
        const deadLetter = (key: string) => ({
          'x-dead-letter-exchange': 'patipasaport.events.dlx',
          'x-dead-letter-routing-key': key,
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
        });
        expect(channel.assertQueue).toHaveBeenCalledWith(queue, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            ...deadLetter(`${queue}.dlq`),
          },
        });
        expect(channel.assertQueue).toHaveBeenCalledWith(`${queue}.retry`, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-message-ttl': 30000,
            ...deadLetter(queue),
          },
        });
        expect(channel.assertQueue).toHaveBeenCalledWith(`${queue}.dlq`, {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        });
        for (const target of [queue, `${queue}.retry`, `${queue}.dlq`]) {
          expect(channel.bindQueue).toHaveBeenCalledWith(
            target,
            'patipasaport.events.dlx',
            target,
          );
        }
      },
    );

    it('bağlamalar: AI kuyruğu uploaded, medical-record kuyruğu AI olaylarını alır', () => {
      const bindings = channel.bindQueue.mock.calls
        .filter(([, exchange]) => exchange === 'patipasaport.events')
        .map(([queue, , key]) => `${queue} <- ${key}`);
      expect(bindings.sort()).toEqual([
        'ai-service.document-uploaded <- com.patipasaport.document.uploaded.v1',
        `${QUEUE} <- com.patipasaport.document.analysis_failed.v1`,
        `${QUEUE} <- com.patipasaport.document.analyzed.v1`,
        `${QUEUE} <- com.patipasaport.document.processing_started.v1`,
      ]);
    });
  });

  // ---Amaç: olayın kalıcı, CloudEvents türünde ve correlation id başlığıyla yayınlandığını doğrulamak ---
  it('publish: routing key = type, kalıcı mesaj, 10 sn zaman aşımı', async () => {
    await service.publish({
      id: 'olay-1',
      type: 'com.patipasaport.document.uploaded.v1',
      payload: { a: 1 },
      correlationId: 'k-1',
    });
    expect(publisher.publish).toHaveBeenCalledWith(
      'patipasaport.events',
      'com.patipasaport.document.uploaded.v1',
      Buffer.from('{"a":1}'),
      {
        persistent: true,
        contentType: 'application/cloudevents+json',
        messageId: 'olay-1',
        type: 'com.patipasaport.document.uploaded.v1',
        headers: { 'x-correlation-id': 'k-1' },
        timeout: 10000,
      },
    );
  });

  // ---Amaç: tüketilen mesajın sonucuna göre onay, tekrar deneme ve DLQ kararını doğrulamak ---
  describe('tüketim kararı', () => {
    let deliver: (message: ConsumeMessage) => void;
    let handler: jest.Mock;
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(async () => {
      handler = jest.fn().mockResolvedValue(undefined);
      await service.consume(QUEUE, handler);
      deliver = consumer.consume.mock.calls[0][1];
    });

    it('prefetch 10 ile tüketir', () => {
      expect(consumer.consume).toHaveBeenCalledWith(
        QUEUE,
        expect.any(Function),
        { prefetch: 10 },
      );
    });

    it('başarılı işlem onaylanır, işleyici correlation id bağlamında çalışır', async () => {
      let seen = '';
      handler.mockImplementation(async () => {
        seen = getCorrelationId();
      });
      const message = consumed({ 'x-correlation-id': 'k-9' });
      deliver(message);
      await settle();
      expect(seen).toBe('k-9');
      expect(consumer.ack).toHaveBeenCalledWith(message);
      expect(consumer.nack).not.toHaveBeenCalled();
    });

    it("geçersiz mesaj tekrar denenmeden DLQ'ya gider", async () => {
      handler.mockRejectedValue(new InvalidEventError('zarf geçersiz'));
      const message = consumed();
      deliver(message);
      await settle();
      expect(consumer.nack).toHaveBeenCalledWith(message, false, false);
      expect(consumer.publish).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, 1],
      [3, 4],
    ])(
      'geçici hata: x-retry-count %s → kopya retry kuyruğuna (%i), asıl mesaj onaylanır',
      async (count, next) => {
        handler.mockRejectedValue(new Error('veritabanı kapalı'));
        const message = consumed(
          count === undefined ? {} : { 'x-retry-count': count },
        );
        deliver(message);
        await settle();
        expect(consumer.publish).toHaveBeenCalledWith(
          'patipasaport.events.dlx',
          `${QUEUE}.retry`,
          message.content,
          expect.objectContaining({
            persistent: true,
            messageId: 'mesaj-1',
            headers: expect.objectContaining({ 'x-retry-count': next }),
            timeout: 10000,
          }),
        );
        expect(consumer.ack).toHaveBeenCalledWith(message);
      },
    );

    it("5. denemede de başarısızsa DLQ'ya gider", async () => {
      handler.mockRejectedValue(new Error('veritabanı kapalı'));
      const message = consumed({ 'x-retry-count': 4 });
      deliver(message);
      await settle();
      expect(consumer.nack).toHaveBeenCalledWith(message, false, false);
      expect(consumer.publish).not.toHaveBeenCalled();
    });

    it('retry kuyruğuna yazılamazsa mesaj kuyruğa geri bırakılır', async () => {
      handler.mockRejectedValue(new Error('veritabanı kapalı'));
      consumer.publish.mockRejectedValue(new Error('kanal kapalı'));
      const message = consumed();
      deliver(message);
      await settle();
      expect(consumer.nack).toHaveBeenCalledWith(message, false, true);
      expect(consumer.ack).not.toHaveBeenCalled();
    });

    it('tüketiciler iptal edilebilir', async () => {
      await service.cancelConsumers();
      expect(consumer.cancelAll).toHaveBeenCalled();
    });
  });
});
