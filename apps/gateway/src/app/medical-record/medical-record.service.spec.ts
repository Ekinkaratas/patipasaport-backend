import {
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { of, throwError } from 'rxjs';
import { ResponseMessages } from '@libs/common';
import { medicalRecord } from '@libs/proto';
import { ApiMedicalRecordService } from './medical-record.service';
import {
  DocumentIntegrityError,
  DocumentStorageService,
} from '../storage/document-storage.service';

const DOC_ID = '0dfc0a17-8fb6-4f0b-9732-6a8ca67465de';
const PDF = Buffer.from('%PDF-1.4 deneme belgesi');

// ---Amaç: medical_record.GetDocument yanıtındaki belgeyi üretmek ---
const documentMessage = (
  over: Partial<medicalRecord.Document> = {},
): medicalRecord.Document => ({
  id: DOC_ID,
  petId: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
  clinicId: '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718',
  storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
  originalName: 'Kan Tahlili.pdf',
  mimeType: 'application/pdf',
  sizeBytes: PDF.length,
  sha256: createHash('sha256').update(PDF).digest('hex'),
  note: '',
  status: medicalRecord.DocumentStatus.QUEUED,
  failureReason: '',
  draftReviewId: '',
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
  ...over,
});

// ---Amaç: StreamableFile içindeki baytları okumak ---
const bytesOf = async (file: StreamableFile): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream() as Readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

describe('ApiMedicalRecordService.getDocumentFile', () => {
  let service: ApiMedicalRecordService;
  let storage: { get: jest.Mock };
  let medicalClient: { getDocument: jest.Mock };
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    storage = { get: jest.fn().mockResolvedValue(PDF) };
    medicalClient = {
      getDocument: jest
        .fn()
        .mockReturnValue(of({ document: documentMessage() })),
    };
    service = new ApiMedicalRecordService(
      { getService: () => medicalClient } as unknown as ClientGrpc,
      storage as unknown as DocumentStorageService,
    );
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  // ---Amaç: yetki kontrolünden geçen belgenin depodan kayıttaki boyutla okunup türü ve tarayıcıda açılacak adıyla döndüğünü doğrulamak ---
  it('yetkiyi GetDocument ile sorar, dosyayı tarayıcıda açılacak biçimde döner', async () => {
    const file = await service.getDocumentFile({ id: DOC_ID });

    expect(medicalClient.getDocument).toHaveBeenCalledWith({ id: DOC_ID });
    expect(storage.get).toHaveBeenCalledWith(
      '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
      PDF.length,
    );
    expect(file.getHeaders()).toEqual({
      type: 'application/pdf',
      length: PDF.length,
      disposition:
        'inline; filename="Kan Tahlili.pdf"; filename*=UTF-8\'\'Kan%20Tahlili.pdf',
    });
    expect(await bytesOf(file)).toEqual(PDF);
  });

  // ---Amaç: download=1 isteğinde dosyanın indirilecek biçimde döndüğünü doğrulamak ---
  it('indirme isteğinde attachment döner', async () => {
    const file = await service.getDocumentFile({ id: DOC_ID, download: true });
    expect(file.getHeaders().disposition).toMatch(/^attachment; /);
    expect(medicalClient.getDocument).toHaveBeenCalledWith({ id: DOC_ID });
  });

  // ---Amaç: depodaki dosya kayıttaki özetle uyuşmazsa dosyanın gönderilmediğini ve olayın loglandığını doğrulamak ---
  it.each([
    [
      'sha256 uyuşmazlığı',
      () =>
        storage.get.mockResolvedValue(Buffer.from('%PDF-1.4 degisti!!!!!!')),
    ],
    [
      'boyut uyuşmazlığı',
      () =>
        storage.get.mockRejectedValue(
          new DocumentIntegrityError('boyut farklı'),
        ),
    ],
  ])('%s → 500, error log', async (_n, arrange) => {
    arrange();
    const error = await service
      .getDocumentFile({ id: DOC_ID })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).message).toBe(
      ResponseMessages.INTERNAL_SERVER_ERROR,
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('bütünlüğü bozuk'),
    );
  });

  // ---Amaç: depo hatalarının istemciye doğru koda çevrildiğini doğrulamak ---
  it.each([
    [
      'dosya depoda yok',
      new NoSuchKey({ message: 'yok', $metadata: {} }),
      NotFoundException,
      ResponseMessages.NOT_FOUND,
    ],
    [
      'depoya ulaşılamıyor',
      new Error('ECONNREFUSED'),
      ServiceUnavailableException,
      ResponseMessages.SERVICE_UNAVAILABLE,
    ],
  ])('%s → %p', async (_n, storageError, type, message) => {
    storage.get.mockRejectedValue(storageError);
    const error = await service
      .getDocumentFile({ id: DOC_ID })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toBe(message);
    expect(errorLog).toHaveBeenCalled();
  });

  // ---Amaç: yetkisiz ya da olmayan belgede depoya hiç gidilmediğini doğrulamak ---
  it('GetDocument hatası aynen yükselir, depoya gidilmez', async () => {
    const grpcError = Object.assign(new Error('NOT_FOUND'), {
      code: 5,
      details: ResponseMessages.NOT_FOUND,
    });
    medicalClient.getDocument.mockReturnValue(throwError(() => grpcError));

    await expect(service.getDocumentFile({ id: DOC_ID })).rejects.toBe(
      grpcError,
    );
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('GetDocument boş yanıt dönerse 500', async () => {
    medicalClient.getDocument.mockReturnValue(of({ document: null }));
    await expect(service.getDocumentFile({ id: DOC_ID })).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(storage.get).not.toHaveBeenCalled();
  });
});

describe('ApiMedicalRecordService.getLabExplanation', () => {
  const RECORD_ID = '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  let service: ApiMedicalRecordService;
  let medicalClient: { getLabExplanation: jest.Mock };

  beforeEach(() => {
    medicalClient = { getLabExplanation: jest.fn() };
    service = new ApiMedicalRecordService(
      { getService: () => medicalClient } as unknown as ClientGrpc,
      { get: jest.fn() } as unknown as DocumentStorageService,
    );
    service.onModuleInit();
  });

  it('kayıt kimliğini medical_record.GetLabExplanation ile sorar, yanıtı BaseResponse içinde sayısal durumla döner', async () => {
    const explanation: medicalRecord.LabExplanationResponse = {
      status: medicalRecord.LabExplanationStatus.LAB_EXPLANATION_READY,
      summary: 'Değerlerin çoğu aralıkta.',
      items: [{ testName: 'ALT', explanation: 'Karaciğer enzimi.' }],
      confidence: 0.82,
      generatedAt: '2026-10-21T09:30:09.000Z',
    };
    medicalClient.getLabExplanation.mockReturnValue(of(explanation));

    const response = await service.getLabExplanation({ recordId: RECORD_ID });

    expect(medicalClient.getLabExplanation).toHaveBeenCalledWith({
      recordId: RECORD_ID,
    });
    expect(response).toMatchObject({
      data: { ...explanation, status: 2 },
      message: ResponseMessages.SUCCESS,
      success: true,
    });
  });

  it.each([
    [7, ResponseMessages.FORBIDDEN],
    [5, ResponseMessages.NOT_FOUND],
  ])(
    'gRPC hatası (code=%i, %s) istemciye aynen yükselir',
    async (code, details) => {
      const grpcError = Object.assign(new Error(details), { code, details });
      medicalClient.getLabExplanation.mockReturnValue(
        throwError(() => grpcError),
      );

      await expect(
        service.getLabExplanation({ recordId: RECORD_ID }),
      ).rejects.toBe(grpcError);
    },
  );
});
