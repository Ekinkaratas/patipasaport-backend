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
import {
  HealthAssessmentStatus,
  HealthRiskLevel,
} from '../../generated/prisma/client';
import { HealthAssessmentEventsConsumer } from './health-assessment-events.consumer';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';

const REQUEST_ID = 'c4a1e9d2-3b5f-4a7c-8e6d-1f2a3b4c5d6e';
const RECORD_ID = '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

const TYPES = {
  generated: [
    'com.patipasaport.health_assessment.generated.v1',
    'HealthAssessmentGenerated',
  ],
  failed: [
    'com.patipasaport.health_assessment.failed.v1',
    'HealthAssessmentFailed',
  ],
  requested: [
    'com.patipasaport.health_assessment.requested.v1',
    'HealthAssessmentRequested',
  ],
  labGenerated: [
    'com.patipasaport.lab_explanation.generated.v1',
    'LabExplanationGenerated',
  ],
} as const;

// ---Amaç: verilen türde ve veriyle bir CloudEvents mesajı üretmek ---
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
    subject: REQUEST_ID,
    time: '2026-11-01T10:15:00.000Z',
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

const ASSESSMENT = {
  summary: 'Hematokrit düşüyor.',
  riskLevel: 'HEALTH_RISK_MODERATE',
  findings: [
    {
      testName: 'HCT',
      trend: 'LAB_TREND_FALLING',
      interpretation: 'Son üç ölçümde azalmış.',
    },
  ],
  questionsForVet: ['Retikülosit sayımı gerekli mi?'],
};

const GENERATED = {
  requestId: REQUEST_ID,
  modelVersion: 'gemma-4-31b/assess-v1',
  confidence: 0.71,
  assessment: ASSESSMENT,
  generatedAt: '2026-11-01T10:15:00.000Z',
};

const FAILED = {
  requestId: REQUEST_ID,
  modelVersion: 'gemma-4-31b/assess-v1',
  errorCode: 'INVALID_AI_OUTPUT',
  errorMessage: 'Model iki denemede de kurallara uygun JSON vermedi',
  failedAt: '2026-11-01T10:15:00.000Z',
};

describe('HealthAssessmentEventsConsumer', () => {
  let consumer: HealthAssessmentEventsConsumer;
  let prisma: {
    healthAssessment: { findUnique: jest.Mock; updateMany: jest.Mock };
    labResult: { findMany: jest.Mock };
  };
  let rabbit: { consume: jest.Mock; cancelConsumers: jest.Mock };
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const expectInvalid = async (msg: ConsumeMessage, reason: string) => {
    const error = await consumer.handle(msg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEventError);
    expect((error as Error).message).toContain(reason);
  };

  const updateCall = () => prisma.healthAssessment.updateMany.mock.calls[0][0];

  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = {
      healthAssessment: {
        findUnique: jest.fn().mockResolvedValue({
          status: HealthAssessmentStatus.PENDING,
          basedOnRecordIds: [RECORD_ID],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      labResult: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ testName: 'HCT ' }, { testName: 'HGB' }]),
      },
    };
    rabbit = {
      consume: jest.fn().mockResolvedValue(undefined),
      cancelConsumers: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new HealthAssessmentEventsConsumer(
      prisma as unknown as PrismaService,
      rabbit as unknown as RabbitMqService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('açılışta kendi kuyruğunu dinler, kapanışta tüketicileri iptal eder', async () => {
    consumer.onApplicationBootstrap();
    expect(rabbit.consume).toHaveBeenCalledWith(
      'medical-record.health-assessment-events',
      expect.any(Function),
    );
    await consumer.onModuleDestroy();
    expect(rabbit.cancelConsumers).toHaveBeenCalled();
  });

  it('tüketici başlatılamazsa hata loglanır', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    rabbit.consume.mockRejectedValue(new Error('kanal kapalı'));
    consumer.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('kanal kapalı'));
  });

  describe('geçersiz olaylar DLQ için reddedilir', () => {
    it.each([
      [
        'JSON değil',
        {
          content: Buffer.from('json değil {'),
          properties: {},
          fields: {},
        } as ConsumeMessage,
        'gövde JSON değil',
      ],
      [
        'şema türüne uymuyor',
        message('generated', GENERATED, {
          dataschema: 'urn:patipasaport:events:HealthAssessmentFailed:v1',
        }),
        'zarfı geçersiz',
      ],
      [
        'kendi yayınladığı requested olayı',
        message('requested', { requestId: REQUEST_ID }),
        'beklenmeyen olay türü',
      ],
      [
        'tahlil açıklaması olayı',
        message('labGenerated', { recordId: REQUEST_ID }),
        'beklenmeyen olay türü',
      ],
      [
        'subject ≠ request_id',
        message('failed', FAILED, { subject: randomUUID() }),
        'request_id geçersiz',
      ],
      [
        'request_id UUID v4 değil',
        message(
          'generated',
          { ...GENERATED, requestId: 'abc' },
          { subject: 'abc' },
        ),
        'request_id geçersiz',
      ],
      [
        'model_version boş',
        message('generated', { ...GENERATED, modelVersion: '' }),
        'model_version',
      ],
      [
        'model_version 64 karakterden uzun',
        message('generated', { ...GENERATED, modelVersion: 'm'.repeat(65) }),
        'model_version',
      ],
      [
        'error_code boş',
        message('failed', { ...FAILED, errorCode: '' }),
        'error_code',
      ],
      [
        'error_code 64 karakterden uzun',
        message('failed', { ...FAILED, errorCode: 'E'.repeat(65) }),
        'error_code',
      ],
    ])('%s', async (_label, msg, reason) => {
      await expectInvalid(msg, reason);
      expect(prisma.healthAssessment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('generated', () => {
    it('geçerli değerlendirme satırı READY yapar', async () => {
      await consumer.handle(message('generated', GENERATED));

      expect(prisma.healthAssessment.findUnique).toHaveBeenCalledWith({
        where: { requestId: REQUEST_ID },
        select: { status: true, basedOnRecordIds: true },
      });
      expect(prisma.labResult.findMany).toHaveBeenCalledWith({
        where: { recordId: { in: [RECORD_ID] } },
        select: { testName: true },
      });
      const call = updateCall();
      expect(call.where).toEqual({
        requestId: REQUEST_ID,
        status: HealthAssessmentStatus.PENDING,
      });
      expect(call.data).toEqual({
        status: HealthAssessmentStatus.READY,
        summary: 'Hematokrit düşüyor.',
        riskLevel: HealthRiskLevel.MODERATE,
        payload: {
          findings: ASSESSMENT.findings,
          questionsForVet: ASSESSMENT.questionsForVet,
        },
        confidence: 0.71,
        modelVersion: 'gemma-4-31b/assess-v1',
        generatedAt: expect.any(Date),
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('kurallara uymayan içerik satırı FAILED INVALID_AI_OUTPUT yapar', async () => {
      await consumer.handle(
        message('generated', {
          ...GENERATED,
          assessment: { ...ASSESSMENT, summary: 'Günde 50 mg verin.' },
        }),
      );

      expect(updateCall().data).toEqual({
        status: HealthAssessmentStatus.FAILED,
        failureReason: 'INVALID_AI_OUTPUT',
        modelVersion: 'gemma-4-31b/assess-v1',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('kurallara uymuyor'),
      );
    });

    it.each([
      ['satır yok (eski istek)', null],
      [
        'satır zaten sonuçlanmış',
        {
          status: HealthAssessmentStatus.READY,
          basedOnRecordIds: [RECORD_ID],
        },
      ],
    ])('%s → olay yok sayılır', async (_label, row) => {
      prisma.healthAssessment.findUnique.mockResolvedValue(row);
      await consumer.handle(message('generated', GENERATED));
      expect(prisma.healthAssessment.updateMany).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('yok sayıldı'));
    });

    it('güncelleme yarışı kaybedilirse olay yok sayılır', async () => {
      prisma.healthAssessment.updateMany.mockResolvedValue({ count: 0 });
      await consumer.handle(message('generated', GENERATED));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('yok sayıldı'));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('failed', () => {
    it('bekleyen satırı hata koduyla FAILED yapar', async () => {
      await consumer.handle(message('failed', FAILED));
      expect(updateCall()).toEqual({
        where: {
          requestId: REQUEST_ID,
          status: HealthAssessmentStatus.PENDING,
        },
        data: {
          status: HealthAssessmentStatus.FAILED,
          failureReason: 'INVALID_AI_OUTPUT',
        },
      });
    });

    it('bekleyen satır yoksa olay yok sayılır', async () => {
      prisma.healthAssessment.updateMany.mockResolvedValue({ count: 0 });
      await consumer.handle(message('failed', FAILED));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('yok sayıldı'));
    });
  });
});
