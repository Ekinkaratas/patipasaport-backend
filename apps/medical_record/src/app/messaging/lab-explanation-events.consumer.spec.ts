jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('amqp-connection-manager', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

import { Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';
import { LabExplanationStatus } from '../../generated/prisma/client';
import { LabExplanationEventsConsumer } from './lab-explanation-events.consumer';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';

const RECORD_ID = '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const PENDING = LabExplanationStatus.PENDING;

const TYPES = {
  generated: [
    'com.patipasaport.lab_explanation.generated.v1',
    'LabExplanationGenerated',
  ],
  failed: [
    'com.patipasaport.lab_explanation.failed.v1',
    'LabExplanationFailed',
  ],
  requested: [
    'com.patipasaport.lab_explanation.requested.v1',
    'LabExplanationRequested',
  ],
  analyzed: ['com.patipasaport.document.analyzed.v1', 'DocumentAnalyzed'],
} as const;

const message = (
  kind: keyof typeof TYPES,
  data: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): ConsumeMessage => {
  const [type, schema] = TYPES[kind];
  const body = {
    specversion: '1.0',
    id: randomUUID(),
    source: '/patipasaport/ai-service',
    type,
    subject: RECORD_ID,
    time: '2026-10-21T09:30:08.000Z',
    datacontenttype: 'application/json',
    dataschema: `urn:patipasaport:events:${schema}:v1`,
    data,
    ...envelope,
  };
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties: {},
    fields: {},
  } as ConsumeMessage;
};

const raw = (text: string) =>
  ({
    content: Buffer.from(text),
    properties: {},
    fields: {},
  }) as ConsumeMessage;

const GENERATED = {
  recordId: RECORD_ID,
  modelVersion: 'gemma-4-31b/explain-v1',
  confidence: 0.82,
  explanation: {
    summary: 'Değerlerin çoğu referans aralığında.',
    items: [{ testName: 'ALT', explanation: 'ALT karaciğer enzimidir.' }],
  },
  generatedAt: '2026-10-21T09:30:08.000Z',
};

const FAILED = {
  recordId: RECORD_ID,
  modelVersion: 'gemma-4-31b/explain-v1',
  errorCode: 'AI_PROVIDER_UNAVAILABLE',
  errorMessage: "AI API'ye 5 denemede ulaşılamadı",
  failedAt: '2026-10-21T09:32:30.000Z',
};

const pendingRow = (status: LabExplanationStatus = PENDING) => ({
  status,
  record: { labResults: [{ testName: 'ALT' }, { testName: 'Kreatinin' }] },
});

describe('LabExplanationEventsConsumer', () => {
  let consumer: LabExplanationEventsConsumer;
  let prisma: {
    labResultExplanation: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let rabbit: { consume: jest.Mock; cancelConsumers: jest.Mock };
  let warn: jest.SpyInstance;

  const expectInvalid = async (msg: ConsumeMessage, reason: string) => {
    const error = await consumer.handle(msg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEventError);
    expect((error as Error).message).toContain(reason);
  };

  const updateData = () =>
    prisma.labResultExplanation.updateMany.mock.calls[0][0].data;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    prisma = {
      labResultExplanation: {
        findUnique: jest.fn().mockResolvedValue(pendingRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    rabbit = {
      consume: jest.fn().mockResolvedValue(undefined),
      cancelConsumers: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new LabExplanationEventsConsumer(
      prisma as unknown as PrismaService,
      rabbit as unknown as RabbitMqService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('açılışta kendi kuyruğunu dinler, kapanışta tüketicileri iptal eder', async () => {
    consumer.onApplicationBootstrap();
    expect(rabbit.consume).toHaveBeenCalledWith(
      'medical-record.lab-explanation-events',
      expect.any(Function),
    );
    await consumer.onModuleDestroy();
    expect(rabbit.cancelConsumers).toHaveBeenCalled();
  });

  describe('zarf', () => {
    it.each([
      ['JSON değil', raw('json değil {'), 'gövde JSON değil'],
      [
        'şema türüne uymuyor',
        message('generated', GENERATED, {
          dataschema: 'urn:patipasaport:events:LabExplanationFailed:v1',
        }),
        'zarfı geçersiz',
      ],
      [
        'bilinmeyen tür',
        message('generated', GENERATED, {
          type: 'com.patipasaport.lab_explanation.deleted.v1',
        }),
        'zarfı geçersiz',
      ],
      [
        'kendi yayınladığı requested olayı',
        message('requested', { recordId: RECORD_ID }),
        'beklenmeyen olay türü',
      ],
      [
        'belge olayı',
        message('analyzed', { documentId: RECORD_ID }),
        'beklenmeyen olay türü',
      ],
      [
        'subject ≠ record_id',
        message('failed', FAILED, { subject: randomUUID() }),
        'record_id geçersiz',
      ],
      [
        'record_id UUID değil',
        message('failed', { ...FAILED, recordId: 'abc' }, { subject: 'abc' }),
        'record_id geçersiz',
      ],
      [
        'record_id UUID v4 değil',
        message(
          'generated',
          {
            ...GENERATED,
            recordId: '7b1e2c3d-4f5a-1b6c-8d7e-9f0a1b2c3d4e',
          },
          { subject: '7b1e2c3d-4f5a-1b6c-8d7e-9f0a1b2c3d4e' },
        ),
        'record_id geçersiz',
      ],
    ])('%s → geçersiz', async (_n, msg, reason) => {
      await expectInvalid(msg, reason);
      expect(prisma.labResultExplanation.findUnique).not.toHaveBeenCalled();
      expect(prisma.labResultExplanation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('generated', () => {
    it('PENDING satır READY olur; içerik kırpılır, generated_at olayın işlendiği andır', async () => {
      const before = Date.now();
      await consumer.handle(
        message('generated', {
          ...GENERATED,
          confidence: 1.4,
          explanation: {
            summary: '  Özet.  ',
            items: [{ testName: ' ALT ', explanation: ' Açıklama. ' }],
          },
        }),
      );

      expect(prisma.labResultExplanation.findUnique).toHaveBeenCalledWith({
        where: { recordId: RECORD_ID },
        select: {
          status: true,
          record: { select: { labResults: { select: { testName: true } } } },
        },
      });
      expect(prisma.labResultExplanation.updateMany).toHaveBeenCalledWith({
        where: { recordId: RECORD_ID, status: PENDING },
        data: {
          status: LabExplanationStatus.READY,
          summary: 'Özet.',
          items: [{ testName: 'ALT', explanation: 'Açıklama.' }],
          confidence: 1,
          modelVersion: 'gemma-4-31b/explain-v1',
          generatedAt: expect.any(Date),
        },
      });
      expect(updateData().generatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(warn).not.toHaveBeenCalled();
    });

    it('kalemsiz açıklama ve snake_case alanlar kabul edilir', async () => {
      await consumer.handle(
        message('generated', {
          record_id: RECORD_ID,
          model_version: 'model-1',
          explanation: { summary: 'Tüm değerler aralıkta.' },
        }),
      );
      expect(updateData()).toMatchObject({
        status: LabExplanationStatus.READY,
        items: [],
        confidence: 0,
        modelVersion: 'model-1',
      });
    });

    it.each([
      [
        'kayıtta olmayan test',
        {
          summary: 'Özet',
          items: [{ testName: 'AST', explanation: 'x' }],
        },
        0.8,
      ],
      ['özet yok', { items: [] }, 0.8],
      ['kalem null', { summary: 'Özet', items: [null] }, 0.8],
      ['confidence "NaN"', GENERATED.explanation, 'NaN'],
    ])(
      'içerik geçersizse (%s) satır FAILED olur, INVALID_AI_OUTPUT yazılır',
      async (_n, explanation, confidence) => {
        await consumer.handle(
          message('generated', { ...GENERATED, explanation, confidence }),
        );
        expect(prisma.labResultExplanation.updateMany).toHaveBeenCalledWith({
          where: { recordId: RECORD_ID, status: PENDING },
          data: {
            status: LabExplanationStatus.FAILED,
            failureReason: 'INVALID_AI_OUTPUT',
            modelVersion: 'gemma-4-31b/explain-v1',
          },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`recordId=${RECORD_ID}`),
        );
      },
    );

    it.each([LabExplanationStatus.READY, LabExplanationStatus.FAILED])(
      'satır %s ise ikinci sonuç yok sayılır',
      async (status) => {
        prisma.labResultExplanation.findUnique.mockResolvedValue(
          pendingRow(status),
        );
        await expect(
          consumer.handle(message('generated', GENERATED)),
        ).resolves.toBeUndefined();
        expect(prisma.labResultExplanation.updateMany).not.toHaveBeenCalled();
      },
    );

    it('eş zamanlı teslimde satır başkası tarafından sonuçlandıysa yok sayılır', async () => {
      prisma.labResultExplanation.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        consumer.handle(message('generated', GENERATED)),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['model_version boş', ''],
      ['model_version 65 karakter', 'm'.repeat(65)],
    ])('%s → geçersiz, veritabanına gidilmez', async (_n, modelVersion) => {
      await expectInvalid(
        message('generated', { ...GENERATED, modelVersion }),
        'model_version',
      );
      expect(prisma.labResultExplanation.findUnique).not.toHaveBeenCalled();
    });

    it('model_version 64 karakter kabul edilir', async () => {
      await consumer.handle(
        message('generated', { ...GENERATED, modelVersion: 'm'.repeat(64) }),
      );
      expect(updateData().status).toBe(LabExplanationStatus.READY);
    });

    it('açıklama satırı yoksa geçersiz', async () => {
      prisma.labResultExplanation.findUnique.mockResolvedValue(null);
      await expectInvalid(
        message('generated', GENERATED),
        'tahlil açıklaması satırı bulunamadı',
      );
      expect(prisma.labResultExplanation.updateMany).not.toHaveBeenCalled();
    });

    it('veritabanı hatası geçici hata olarak yukarı fırlatılır', async () => {
      const error = new Error('bağlantı koptu');
      prisma.labResultExplanation.updateMany.mockRejectedValue(error);
      await expect(
        consumer.handle(message('generated', GENERATED)),
      ).rejects.toBe(error);
    });
  });

  describe('failed', () => {
    it('PENDING satır FAILED olur, failure_reason = error_code', async () => {
      await consumer.handle(message('failed', FAILED));
      expect(prisma.labResultExplanation.updateMany).toHaveBeenCalledWith({
        where: { recordId: RECORD_ID, status: PENDING },
        data: {
          status: LabExplanationStatus.FAILED,
          failureReason: 'AI_PROVIDER_UNAVAILABLE',
        },
      });
    });

    it.each([
      ['boş', ''],
      ['65 karakter', 'E'.repeat(65)],
    ])('error_code %s → geçersiz', async (_n, errorCode) => {
      await expectInvalid(
        message('failed', { ...FAILED, errorCode }),
        'error_code',
      );
      expect(prisma.labResultExplanation.updateMany).not.toHaveBeenCalled();
    });

    it('satır sonuçlanmışsa yok sayılır, yoksa geçersiz', async () => {
      prisma.labResultExplanation.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        consumer.handle(message('failed', FAILED)),
      ).resolves.toBeUndefined();
      expect(prisma.labResultExplanation.count).toHaveBeenCalledWith({
        where: { recordId: RECORD_ID },
      });

      prisma.labResultExplanation.count.mockResolvedValue(0);
      await expectInvalid(
        message('failed', FAILED),
        'tahlil açıklaması satırı bulunamadı',
      );
    });
  });
});
