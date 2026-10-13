jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';
import { medicalRecord } from '@libs/proto';
import {
  DocumentStatus,
  Prisma,
  RecordType,
} from '../../generated/prisma/client';
import { DocumentEventsConsumer } from './document-events.consumer';
import { InvalidEventError, RabbitMqService } from './rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';

const DOC_ID = '0dfc0a17-8fb6-4f0b-9732-6a8ca67465de';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const OPEN = { in: [DocumentStatus.QUEUED, DocumentStatus.PROCESSING] };

const TYPES = {
  started: [
    'com.patipasaport.document.processing_started.v1',
    'DocumentProcessingStarted',
  ],
  analyzed: ['com.patipasaport.document.analyzed.v1', 'DocumentAnalyzed'],
  failed: [
    'com.patipasaport.document.analysis_failed.v1',
    'DocumentAnalysisFailed',
  ],
  uploaded: ['com.patipasaport.document.uploaded.v1', 'DocumentUploaded'],
} as const;

// ---Amaç: AI servisinin Python biçiminde yayınlayacağı CloudEvents mesajını üretmek ---
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
    subject: DOC_ID,
    time: '2026-10-13T08:30:00.000Z',
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

const ANALYZED = {
  documentId: DOC_ID,
  modelVersion: 'model-1',
  confidence: 0.87,
  proposal: {
    type: 'VACCINATION',
    title: 'Kuduz aşısı',
    recordedAt: '2026-10-12',
    vaccination: { vaccineName: 'Kuduz', administeredAt: '2026-10-12' },
  },
};

describe('DocumentEventsConsumer', () => {
  let consumer: DocumentEventsConsumer;
  let prisma: {
    document: {
      updateMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
    };
    draftReview: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let rabbit: { consume: jest.Mock; cancelConsumers: jest.Mock };

  const expectInvalid = async (msg: ConsumeMessage, reason: string) => {
    const error = await consumer.handle(msg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEventError);
    expect((error as Error).message).toContain(reason);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = {
      document: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest
          .fn()
          .mockResolvedValue({ petId: PET_ID, clinicId: CLINIC_ID }),
      },
      draftReview: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    rabbit = {
      consume: jest.fn().mockResolvedValue(undefined),
      cancelConsumers: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new DocumentEventsConsumer(
      prisma as unknown as PrismaService,
      rabbit as unknown as RabbitMqService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ---Amaç: tüketicinin kendi kuyruğuna bağlandığını ve kapanışta bıraktığını doğrulamak ---
  it('açılışta kendi kuyruğunu dinler, kapanışta tüketicileri iptal eder', async () => {
    consumer.onApplicationBootstrap();
    expect(rabbit.consume).toHaveBeenCalledWith(
      'medical-record.document-events',
      expect.any(Function),
    );
    await consumer.onModuleDestroy();
    expect(rabbit.cancelConsumers).toHaveBeenCalled();
  });

  // ---Amaç: bozuk ya da beklenmeyen mesajların geçersiz sayıldığını doğrulamak ---
  describe('zarf', () => {
    it.each([
      ['JSON değil', raw('json değil {'), 'gövde JSON değil'],
      [
        'şema türüne uymuyor',
        message('analyzed', ANALYZED, {
          dataschema: 'urn:patipasaport:events:DocumentProcessingStarted:v1',
        }),
        'zarfı geçersiz',
      ],
      [
        'bilinmeyen tür',
        message('analyzed', ANALYZED, {
          type: 'com.patipasaport.document.deleted.v1',
        }),
        'zarfı geçersiz',
      ],
      [
        'kendi yayınladığı uploaded olayı',
        message('uploaded', { documentId: DOC_ID }),
        'beklenmeyen olay türü',
      ],
      [
        'subject ≠ document_id',
        message('started', { documentId: DOC_ID }, { subject: randomUUID() }),
        'document_id geçersiz',
      ],
      [
        'document_id UUID değil',
        message('started', { documentId: 'abc' }, { subject: 'abc' }),
        'document_id geçersiz',
      ],
    ])('%s → geçersiz', async (_n, msg, reason) => {
      await expectInvalid(msg, reason);
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: işlem başladı olayının yalnızca kuyruktaki belgeyi ilerlettiğini doğrulamak ---
  describe('processing_started', () => {
    it('QUEUED belge PROCESSING olur', async () => {
      await consumer.handle(
        message('started', { documentId: DOC_ID, modelVersion: 'model-1' }),
      );
      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, status: DocumentStatus.QUEUED },
        data: { status: DocumentStatus.PROCESSING },
      });
    });

    it('belge zaten ilerlediyse olay yok sayılır', async () => {
      prisma.document.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        consumer.handle(message('started', { documentId: DOC_ID })),
      ).resolves.toBeUndefined();
    });

    it('belge yoksa geçersiz', async () => {
      prisma.document.updateMany.mockResolvedValue({ count: 0 });
      prisma.document.count.mockResolvedValue(0);
      await expectInvalid(
        message('started', { documentId: DOC_ID }),
        'belge bulunamadı',
      );
    });
  });

  // ---Amaç: analiz sonucunun taslağa dönüştüğünü, tekrarların ve geçersiz önerilerin ayrıldığını doğrulamak ---
  describe('analyzed', () => {
    it('taslak açılır, belge DRAFT_READY olur; öneri sayısal enum ile saklanır', async () => {
      await consumer.handle(message('analyzed', ANALYZED));

      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, status: OPEN },
        data: { status: DocumentStatus.DRAFT_READY },
      });
      const [{ data }] = prisma.draftReview.create.mock.calls[0];
      expect(data).toMatchObject({
        documentId: DOC_ID,
        petId: PET_ID,
        clinicId: CLINIC_ID,
        recordType: RecordType.VACCINATION,
        modelVersion: 'model-1',
        confidence: 0.87,
      });
      expect(data.proposedPayload).toEqual({
        type: medicalRecord.RecordType.VACCINATION,
        title: 'Kuduz aşısı',
        notes: '',
        recordedAt: '2026-10-12',
        vaccination: {
          vaccineName: 'Kuduz',
          batchNumber: '',
          administeredAt: '2026-10-12',
          nextDueAt: '',
        },
      });
    });

    it('snake_case alanlar da okunur', async () => {
      await consumer.handle(
        message('analyzed', {
          document_id: DOC_ID,
          model_version: 'model-1',
          confidence: 0.5,
          proposal: {
            type: 'EXAMINATION',
            title: 'Kontrol',
            recorded_at: '2026-10-12',
          },
        }),
      );
      expect(
        prisma.draftReview.create.mock.calls[0][0].data.proposedPayload
          .recordedAt,
      ).toBe('2026-10-12');
    });

    it('belge kapanmışsa taslak açılmaz', async () => {
      prisma.document.updateMany.mockResolvedValue({ count: 0 });
      await consumer.handle(message('analyzed', ANALYZED));
      expect(prisma.draftReview.create).not.toHaveBeenCalled();
    });

    it('aynı belgeye ikinci taslak (unique ihlali) yok sayılır', async () => {
      prisma.draftReview.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('tekrar', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        consumer.handle(message('analyzed', ANALYZED)),
      ).resolves.toBeUndefined();
    });

    it('başka veritabanı hatası geçici hata olarak yukarı fırlatılır', async () => {
      const error = new Error('bağlantı koptu');
      prisma.draftReview.create.mockRejectedValue(error);
      await expect(consumer.handle(message('analyzed', ANALYZED))).rejects.toBe(
        error,
      );
    });

    it.each([
      ['öneri yok', { ...ANALYZED, proposal: undefined }, 'öneri yok'],
      [
        'öneri türü belirsiz',
        {
          ...ANALYZED,
          proposal: { ...ANALYZED.proposal, type: 'RECORD_TYPE_UNSPECIFIED' },
        },
        'kayıt türü geçersiz',
      ],
      ['model_version boş', { ...ANALYZED, modelVersion: '' }, 'model_version'],
      [
        'model_version 65 karakter',
        { ...ANALYZED, modelVersion: 'm'.repeat(65) },
        'model_version',
      ],
      ['confidence 1.5', { ...ANALYZED, confidence: 1.5 }, 'confidence'],
      ['confidence negatif', { ...ANALYZED, confidence: -0.1 }, 'confidence'],
    ])('%s → geçersiz, yazılmaz', async (_n, data, reason) => {
      await expectInvalid(message('analyzed', data), reason);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('belge yoksa geçersiz', async () => {
      prisma.document.findUnique.mockResolvedValue(null);
      await expectInvalid(message('analyzed', ANALYZED), 'belge bulunamadı');
      expect(prisma.draftReview.create).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: analiz hatasının belgeyi FAILED yaptığını ve hata kodunu sakladığını doğrulamak ---
  describe('analysis_failed', () => {
    it('açık belge FAILED olur, failure_reason = error_code', async () => {
      await consumer.handle(
        message('failed', {
          documentId: DOC_ID,
          errorCode: 'UNREADABLE',
          errorMessage: 'okunamadı',
        }),
      );
      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, status: OPEN },
        data: { status: DocumentStatus.FAILED, failureReason: 'UNREADABLE' },
      });
    });

    it.each([
      ['boş', ''],
      ['65 karakter', 'E'.repeat(65)],
    ])('error_code %s → geçersiz', async (_n, errorCode) => {
      await expectInvalid(
        message('failed', { documentId: DOC_ID, errorCode }),
        'error_code',
      );
    });

    it('belge kapanmışsa yok sayılır, yoksa geçersiz', async () => {
      prisma.document.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        consumer.handle(
          message('failed', { documentId: DOC_ID, errorCode: 'X' }),
        ),
      ).resolves.toBeUndefined();
      prisma.document.count.mockResolvedValue(0);
      await expectInvalid(
        message('failed', { documentId: DOC_ID, errorCode: 'X' }),
        'belge bulunamadı',
      );
    });
  });
});
