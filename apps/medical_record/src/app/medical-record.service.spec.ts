jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { access, medicalRecord } from '@libs/proto';
import { AuthUser, ResponseMessages } from '@libs/common';
import { CreateRecordRequestDto, ReviewDraftRequestDto } from '@libs/dto';
import {
  DocumentStatus,
  DraftReviewStatus,
  Prisma,
  RecordType,
} from '../generated/prisma/client';
import { MedicalRecordService } from './medical-record.service';
import { PrismaService } from './prisma/prisma.service';

const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const OTHER_PET_ID = '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const OTHER_CLINIC_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OWNER_ID = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const DOC_ID = '0dfc0a17-8fb6-4f0b-9732-6a8ca67465de';
const DRAFT_ID = '54fd68b6-a352-4297-a333-dd33d3981dca';
const CREATED = new Date('2026-10-13T08:30:00.000Z');

const CLINIC: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: CLINIC_ID,
  clientType: access.ClientType.WEB,
};
const OWNER: AuthUser = {
  userId: OWNER_ID,
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
};

// ---Amaç: veritabanındaki belge satırını taslak bilgisiyle üretmek ---
const documentRow = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  petId: PET_ID,
  clinicId: CLINIC_ID,
  storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
  originalName: 'Kan Tahlili.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  note: null,
  status: DocumentStatus.QUEUED,
  failureReason: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  draftReview: null,
  ...over,
});

// ---Amaç: veritabanındaki kayıt satırını ayrıntılarıyla üretmek ---
const recordRow = (over: Record<string, unknown> = {}) => ({
  id: 'kayit-1',
  petId: PET_ID,
  clinicId: CLINIC_ID,
  type: RecordType.EXAMINATION,
  title: 'Genel muayene',
  notes: null,
  recordedAt: new Date('2026-10-12T00:00:00.000Z'),
  sourceDocumentId: null,
  sourceDraftReviewId: null,
  createdAt: CREATED,
  vaccination: null,
  prescription: null,
  labResults: [],
  attachments: [],
  ...over,
});

const PROPOSAL = {
  type: medicalRecord.RecordType.VACCINATION,
  title: 'Karma aşı',
  notes: '',
  recordedAt: '2026-10-12',
  vaccination: {
    vaccineName: 'Karma',
    batchNumber: '',
    administeredAt: '2026-10-12',
    nextDueAt: '',
  },
};

// ---Amaç: veritabanındaki taslak satırını kaynak belgesiyle üretmek ---
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: DRAFT_ID,
  documentId: DOC_ID,
  petId: PET_ID,
  clinicId: CLINIC_ID,
  recordType: RecordType.VACCINATION,
  proposedPayload: PROPOSAL,
  approvedPayload: null,
  modelVersion: 'model-1',
  confidence: 0.9,
  status: DraftReviewStatus.PENDING,
  reviewNote: null,
  reviewedByClinicId: null,
  reviewedAt: null,
  createdRecordId: null,
  createdAt: CREATED,
  document: documentRow(),
  ...over,
});

// ---Amaç: Prisma'nın bilinen hata kodlarını adapter kısıt bilgisiyle taklit etmek ---
const prismaError = (code: string, index?: string) =>
  new Prisma.PrismaClientKnownRequestError('test hatası', {
    code,
    clientVersion: 'test',
    meta: index
      ? { driverAdapterError: { cause: { constraint: { index } } } }
      : undefined,
  });

// ---Amaç: alt servisten dönen gRPC hatasını taklit etmek ---
const grpcError = (code: number, details?: string) =>
  Object.assign(new Error(details ?? 'grpc hatası'), { code, details });

// ---Amaç: ClientGrpc.getService'in döndüreceği istemciyi bağlamak ---
const clientGrpcFor = (implementation: unknown): ClientGrpc =>
  ({ getService: () => implementation }) as unknown as ClientGrpc;

// ---Amaç: servisin fırlattığı RpcException mesajını yakalamak ---
const rejectionMessage = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).message;
};

const allowed = (value: boolean) => of({ allowed: value });

describe('MedicalRecordService', () => {
  let service: MedicalRecordService;
  let prisma: {
    document: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    outbox: { create: jest.Mock };
    medicalRecord: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    vaccination: { findMany: jest.Mock; count: jest.Mock };
    prescription: { findMany: jest.Mock };
    labResult: { findMany: jest.Mock; count: jest.Mock };
    draftReview: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let accessClient: { checkAccess: jest.Mock; listMyConsents: jest.Mock };
  let petsClient: { getPetOwner: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    prisma = {
      document: {
        create: jest.fn().mockResolvedValue(documentRow()),
        findUnique: jest.fn().mockResolvedValue(documentRow()),
        findMany: jest.fn().mockResolvedValue([documentRow()]),
        count: jest.fn().mockResolvedValue(1),
      },
      outbox: { create: jest.fn().mockResolvedValue({}) },
      medicalRecord: {
        create: jest.fn().mockResolvedValue(recordRow()),
        findMany: jest.fn().mockResolvedValue([recordRow()]),
        count: jest.fn().mockResolvedValue(1),
      },
      vaccination: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      prescription: { findMany: jest.fn().mockResolvedValue([]) },
      labResult: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      draftReview: {
        findUnique: jest.fn().mockResolvedValue(draftRow()),
        findMany: jest.fn().mockResolvedValue([draftRow()]),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue(draftRow()),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );
    accessClient = {
      checkAccess: jest.fn().mockReturnValue(allowed(true)),
      listMyConsents: jest
        .fn()
        .mockReturnValue(
          of({ consents: [], total: 0, page: 1, pageSize: 128 }),
        ),
    };
    petsClient = {
      getPetOwner: jest
        .fn()
        .mockReturnValue(of({ petId: PET_ID, ownerUserId: OWNER_ID })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MedicalRecordService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'ACCESS_SERVICE', useValue: clientGrpcFor(accessClient) },
        { provide: 'PETS_SERVICE', useValue: clientGrpcFor(petsClient) },
      ],
    }).compile();

    service = moduleRef.get(MedicalRecordService);
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  const registerRequest: medicalRecord.RegisterDocumentRequest = {
    petId: PET_ID,
    storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
    originalName: 'Kan Tahlili.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    note: '',
  };

  // ---Amaç: belge kaydının rıza kontrolünden sonra belge ve outbox satırını aynı transaction'da yazdığını doğrulamak ---
  describe('registerDocument', () => {
    it('medical_write rızasıyla belge ve CloudEvents zarflı outbox satırı yazılır', async () => {
      const response = await service.registerDocument(registerRequest, CLINIC);

      expect(accessClient.checkAccess).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        requiredScopes: ['medical_write'],
      });
      expect(prisma.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clinicId: CLINIC_ID, note: null }),
        }),
      );
      const [{ data }] = prisma.outbox.create.mock.calls[0];
      expect(data).toMatchObject({
        type: 'com.patipasaport.document.uploaded.v1',
        correlationId: expect.any(String),
        payload: {
          specversion: '1.0',
          source: '/patipasaport/medical-record',
          type: 'com.patipasaport.document.uploaded.v1',
          subject: DOC_ID,
          dataschema: 'urn:patipasaport:events:DocumentUploaded:v1',
          data: {
            documentId: DOC_ID,
            petId: PET_ID,
            clinicId: CLINIC_ID,
            storagePath: registerRequest.storagePath,
            sizeBytes: 2048,
          },
        },
      });
      expect(data.id).toBe(data.payload.id);
      expect(response.document).toMatchObject({
        id: DOC_ID,
        status: medicalRecord.DocumentStatus.QUEUED,
      });
    });

    it('rıza yoksa FORBIDDEN, hiçbir şey yazılmaz', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(
          service.registerDocument(registerRequest, CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.document.create).not.toHaveBeenCalled();
      expect(prisma.outbox.create).not.toHaveBeenCalled();
    });

    it.each([
      ['documents_storage_path_key', ResponseMessages.CONFLICT],
      ['baska_kisit', ResponseMessages.INTERNAL_SERVER_ERROR],
    ])('unique ihlali (%s) → %s', async (index, expected) => {
      prisma.document.create.mockRejectedValue(prismaError('P2002', index));
      expect(
        await rejectionMessage(
          service.registerDocument(registerRequest, CLINIC),
        ),
      ).toBe(expected);
    });

    it('access servisine ulaşılamazsa SERVICE_UNAVAILABLE', async () => {
      accessClient.checkAccess.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );
      expect(
        await rejectionMessage(
          service.registerDocument(registerRequest, CLINIC),
        ),
      ).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });
  });

  // ---Amaç: belgeyi yükleyen kliniğin medical_write rızasıyla, hasta sahibinin ise sahiplikle görebildiğini doğrulamak ---
  describe('getDocument', () => {
    it('yükleyen klinik rızayla görür, taslak id taşınır', async () => {
      prisma.document.findUnique.mockResolvedValue(
        documentRow({ draftReview: { id: DRAFT_ID } }),
      );
      const response = await service.getDocument({ id: DOC_ID }, CLINIC);
      expect(response.document?.draftReviewId).toBe(DRAFT_ID);
      expect(accessClient.checkAccess).toHaveBeenCalledWith(
        expect.objectContaining({ requiredScopes: ['medical_write'] }),
      );
    });

    it.each([
      ['olmayan belge', null],
      ['başka kliniğin belgesi', documentRow({ clinicId: OTHER_CLINIC_ID })],
    ])('%s → NOT_FOUND, rıza sorulmaz', async (_n, row) => {
      prisma.document.findUnique.mockResolvedValue(row);
      expect(
        await rejectionMessage(service.getDocument({ id: DOC_ID }, CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('rıza iptal edildiyse FORBIDDEN', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(service.getDocument({ id: DOC_ID }, CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
    });

    it('hasta sahibi kendi hayvanının başka klinikçe yüklenen belgesini sahiplikle görür, rıza sorulmaz', async () => {
      prisma.document.findUnique.mockResolvedValue(
        documentRow({ clinicId: OTHER_CLINIC_ID }),
      );
      const response = await service.getDocument({ id: DOC_ID }, OWNER);
      expect(response.document?.clinicId).toBe(OTHER_CLINIC_ID);
      expect(petsClient.getPetOwner).toHaveBeenCalledWith({ petId: PET_ID });
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('başka sahibin hayvanının belgesi NOT_FOUND; olmayan belgede sahiplik sorulmaz', async () => {
      petsClient.getPetOwner.mockReturnValue(
        of({ petId: PET_ID, ownerUserId: 'baska-sahip' }),
      );
      expect(
        await rejectionMessage(service.getDocument({ id: DOC_ID }, OWNER)),
      ).toBe(ResponseMessages.NOT_FOUND);

      petsClient.getPetOwner.mockClear();
      prisma.document.findUnique.mockResolvedValue(null);
      expect(
        await rejectionMessage(service.getDocument({ id: DOC_ID }, OWNER)),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(petsClient.getPetOwner).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: belge listesinde kliniğin yalnızca kendi yüklediklerini medical_write rızasıyla, hasta sahibinin kendi hayvanının tüm belgelerini gördüğünü doğrulamak ---
  describe('listDocumentsByPet', () => {
    const request: medicalRecord.ListDocumentsByPetRequest = {
      petId: PET_ID,
      page: 2,
      pageSize: 8,
    };

    it('klinik medical_write rızasıyla yalnızca kendi yüklediklerini en yeni önce, sayfalı görür', async () => {
      const response = await service.listDocumentsByPet(request, CLINIC);

      expect(accessClient.checkAccess).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        requiredScopes: ['medical_write'],
      });
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { petId: PET_ID, clinicId: CLINIC_ID },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: 8,
          take: 8,
        }),
      );
      expect(prisma.document.count).toHaveBeenCalledWith({
        where: { petId: PET_ID, clinicId: CLINIC_ID },
      });
      expect(response).toMatchObject({ total: 1, page: 2, pageSize: 8 });
      expect(response.documents).toEqual([
        expect.objectContaining({
          id: DOC_ID,
          originalName: 'Kan Tahlili.pdf',
          status: medicalRecord.DocumentStatus.QUEUED,
        }),
      ]);
    });

    it('hasta sahibi sahiplikle hayvanın tüm kliniklerden belgelerini görür, rıza sorulmaz', async () => {
      await service.listDocumentsByPet(request, OWNER);

      expect(petsClient.getPetOwner).toHaveBeenCalledWith({ petId: PET_ID });
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
      expect(prisma.document.findMany.mock.calls[0][0].where).toEqual({
        petId: PET_ID,
      });
    });

    it('durum filtresi veritabanı durumuna çevrilir', async () => {
      await service.listDocumentsByPet(
        { ...request, status: medicalRecord.DocumentStatus.FAILED },
        OWNER,
      );
      expect(prisma.document.findMany.mock.calls[0][0].where).toEqual({
        petId: PET_ID,
        status: DocumentStatus.FAILED,
      });
    });

    it('başka sahibin hayvanı NOT_FOUND, rızasız klinik FORBIDDEN; veritabanına gidilmez', async () => {
      petsClient.getPetOwner.mockReturnValue(
        of({ petId: PET_ID, ownerUserId: 'baska-sahip' }),
      );
      expect(
        await rejectionMessage(service.listDocumentsByPet(request, OWNER)),
      ).toBe(ResponseMessages.NOT_FOUND);

      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(service.listDocumentsByPet(request, CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.document.findMany).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: elle kaydın rıza ve ek belge kontrolünden sonra kayıt, tipli satır ve eklerle yazıldığını doğrulamak ---
  describe('createRecord', () => {
    const content = {
      type: medicalRecord.RecordType.EXAMINATION,
      title: 'Genel muayene',
      recordedAt: '2026-10-12',
    };
    const request = (attachments?: string[]) =>
      ({
        petId: PET_ID,
        content,
        attachments: attachments?.map((documentId) => ({ documentId })),
      }) as unknown as CreateRecordRequestDto;

    it("eksiz kayıt: ek kontrolü yapılmaz, klinik JWT'den gelir", async () => {
      const response = await service.createRecord(request(), CLINIC);
      expect(prisma.document.count).not.toHaveBeenCalled();
      expect(prisma.medicalRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            petId: PET_ID,
            clinicId: CLINIC_ID,
            type: RecordType.EXAMINATION,
            attachments: { create: [] },
          }),
        }),
      );
      expect(response.record?.id).toBe('kayit-1');
    });

    it('ekler aynı hayvan ve kliniğin belgeleriyse kayda eklenir', async () => {
      prisma.document.count.mockResolvedValue(2);
      await service.createRecord(request([DOC_ID, 'belge-2']), CLINIC);
      expect(prisma.document.count).toHaveBeenCalledWith({
        where: {
          id: { in: [DOC_ID, 'belge-2'] },
          petId: PET_ID,
          clinicId: CLINIC_ID,
        },
      });
      expect(
        prisma.medicalRecord.create.mock.calls[0][0].data.attachments,
      ).toEqual({
        create: [{ documentId: DOC_ID }, { documentId: 'belge-2' }],
      });
    });

    it('eklerden biri bulunamazsa NOT_FOUND, kayıt yazılmaz', async () => {
      prisma.document.count.mockResolvedValue(1);
      expect(
        await rejectionMessage(
          service.createRecord(request([DOC_ID, 'belge-2']), CLINIC),
        ),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
    });

    it('medical_write yoksa FORBIDDEN', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(service.createRecord(request(), CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: listelerde hasta sahibinin sahiplikle, kliniğin ilgili scope'la eriştiğini doğrulamak ---
  describe('liste erişimi', () => {
    const page = { petId: PET_ID, page: 1, pageSize: 8 };
    const lists: [string, () => Promise<unknown>, string][] = [];

    beforeEach(() => {
      prisma.$queryRaw.mockResolvedValue([]);
      lists.length = 0;
      lists.push(
        [
          'listRecordsByPet',
          () =>
            service.listRecordsByPet(
              { ...page, fromDate: '', toDate: '' },
              currentUser,
            ),
          'medical_read',
        ],
        [
          'listVaccinations',
          () => service.listVaccinations(page, currentUser),
          'vaccination_read',
        ],
        [
          'listPrescriptions',
          () => service.listPrescriptions(page, currentUser),
          'prescription_read',
        ],
        [
          'listLabResults',
          () => service.listLabResults(page, currentUser),
          'medical_read',
        ],
      );
    });

    let currentUser: AuthUser = CLINIC;

    it.each([0, 1, 2, 3])(
      'klinik ilgili scope ile kontrol edilir (%i)',
      async (index) => {
        currentUser = CLINIC;
        const [, call, scope] = lists[index];
        await call();
        expect(accessClient.checkAccess).toHaveBeenCalledWith({
          clinicId: CLINIC_ID,
          petId: PET_ID,
          requiredScopes: [scope],
        });
        expect(petsClient.getPetOwner).not.toHaveBeenCalled();
      },
    );

    it.each([0, 1, 2, 3])(
      'hasta sahibi pets ile kontrol edilir, rıza sorulmaz (%i)',
      async (index) => {
        currentUser = OWNER;
        await lists[index][1]();
        expect(petsClient.getPetOwner).toHaveBeenCalledWith({ petId: PET_ID });
        expect(accessClient.checkAccess).not.toHaveBeenCalled();
      },
    );

    it('hayvan başkasınınsa NOT_FOUND', async () => {
      petsClient.getPetOwner.mockReturnValue(
        of({ petId: PET_ID, ownerUserId: 'baska-sahip' }),
      );
      expect(
        await rejectionMessage(service.listVaccinations(page, OWNER)),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('pets NOT_FOUND döndürürse aynen aktarılır', async () => {
      petsClient.getPetOwner.mockReturnValue(
        throwError(() =>
          grpcError(status.NOT_FOUND, ResponseMessages.NOT_FOUND),
        ),
      );
      expect(await rejectionMessage(service.listLabResults(page, OWNER))).toBe(
        ResponseMessages.NOT_FOUND,
      );
    });

    it('scope eksikse FORBIDDEN, veritabanına gidilmez', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(
          service.listRecordsByPet(
            { ...page, fromDate: '', toDate: '' },
            CLINIC,
          ),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.medicalRecord.findMany).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: liste filtrelerinin, sıralamanın ve sayfalamanın sorguya doğru yansıdığını doğrulamak ---
  describe('liste sorguları', () => {
    it('kayıtlar: tür ve tarih filtresi, en yeni önce, sayfalama', async () => {
      const response = await service.listRecordsByPet(
        {
          petId: PET_ID,
          type: medicalRecord.RecordType.LAB_RESULT,
          fromDate: '2026-10-01',
          toDate: '2026-10-12',
          page: 2,
          pageSize: 8,
        },
        CLINIC,
      );
      expect(prisma.medicalRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            petId: PET_ID,
            type: RecordType.LAB_RESULT,
            recordedAt: {
              gte: new Date('2026-10-01T00:00:00.000Z'),
              lte: new Date('2026-10-12T00:00:00.000Z'),
            },
          },
          orderBy: [
            { recordedAt: 'desc' },
            { createdAt: 'desc' },
            { id: 'asc' },
          ],
          skip: 8,
          take: 8,
        }),
      );
      expect(response).toMatchObject({ total: 1, page: 2, pageSize: 8 });
    });

    it('kayıtlar: filtre verilmezse yalnızca hayvana göre', async () => {
      await service.listRecordsByPet(
        { petId: PET_ID, fromDate: '', toDate: '', page: 1, pageSize: 8 },
        CLINIC,
      );
      expect(prisma.medicalRecord.findMany.mock.calls[0][0].where).toEqual({
        petId: PET_ID,
      });
    });

    it('aşılar: onlyUpcoming → bugün ve sonrası, en yakın önce', async () => {
      await service.listVaccinations(
        { petId: PET_ID, onlyUpcoming: true, page: 1, pageSize: 8 },
        CLINIC,
      );
      const [{ where, orderBy }] = prisma.vaccination.findMany.mock.calls[0];
      expect(where.record).toEqual({ petId: PET_ID });
      expect(where.nextDueAt.gte).toBeInstanceOf(Date);
      expect(orderBy).toEqual([{ nextDueAt: 'asc' }, { id: 'asc' }]);
    });

    it('aşılar: filtresiz → uygulama tarihine göre en yeni önce', async () => {
      await service.listVaccinations(
        { petId: PET_ID, page: 1, pageSize: 8 },
        CLINIC,
      );
      const [{ where, orderBy }] = prisma.vaccination.findMany.mock.calls[0];
      expect(where).toEqual({ record: { petId: PET_ID } });
      expect(orderBy).toEqual([{ administeredAt: 'desc' }, { id: 'asc' }]);
    });

    it('reçeteler: ham sorgudaki sıra korunur, onlyActive süre koşulunu ekler', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'r2' }, { id: 'r1' }])
        .mockResolvedValueOnce([{ total: 2 }]);
      const owner = { record: { petId: PET_ID, clinicId: CLINIC_ID } };
      const prescription = (id: string) => ({
        id,
        recordId: `kayit-${id}`,
        medicationName: id,
        dosage: '1',
        frequency: '1',
        durationDays: 7,
        instructions: null,
        prescribedAt: new Date('2026-10-12T00:00:00.000Z'),
        ...owner,
      });
      prisma.prescription.findMany.mockResolvedValue([
        prescription('r1'),
        prescription('r2'),
      ]);

      const response = await service.listPrescriptions(
        { petId: PET_ID, onlyActive: true, page: 1, pageSize: 8 },
        CLINIC,
      );

      expect(response.prescriptions.map((p) => p.id)).toEqual(['r2', 'r1']);
      expect(response.total).toBe(2);
      expect(JSON.stringify(prisma.$queryRaw.mock.calls[0])).toContain(
        'p.prescribed_at + p.duration_days - 1 >=',
      );
    });

    it('reçeteler: onlyActive yoksa süre koşulu eklenmez, boş sonuçta ikinci sorgu yapılmaz', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);
      const response = await service.listPrescriptions(
        { petId: PET_ID, page: 1, pageSize: 8 },
        CLINIC,
      );
      expect(JSON.stringify(prisma.$queryRaw.mock.calls[0])).not.toContain(
        'duration_days',
      );
      expect(prisma.prescription.findMany).not.toHaveBeenCalled();
      expect(response).toMatchObject({ prescriptions: [], total: 0 });
    });

    it('tahliller: testName içerir, büyük/küçük harf duyarsız', async () => {
      await service.listLabResults(
        { petId: PET_ID, testName: 'hemo', page: 1, pageSize: 8 },
        CLINIC,
      );
      const [{ where, orderBy }] = prisma.labResult.findMany.mock.calls[0];
      expect(where).toEqual({
        record: { petId: PET_ID },
        testName: { contains: 'hemo', mode: 'insensitive' },
      });
      expect(orderBy).toEqual([
        { sampledAt: 'desc' },
        { testName: 'asc' },
        { id: 'asc' },
      ]);
    });
  });

  // ---Amaç: taslak listesinin yalnızca kliniğin kendi ve medical_write rızalı hayvanlarını döndürdüğünü doğrulamak ---
  describe('listDraftReviews', () => {
    const consent = (
      petId: string,
      scopes: string[],
      consentStatus = access.ConsentStatus.ACTIVE,
    ) => ({
      petId,
      scopes,
      status: consentStatus,
    });

    it('petId verilirse o hayvanda medical_write sorulur', async () => {
      await service.listDraftReviews(
        {
          petId: PET_ID,
          status: medicalRecord.DraftReviewStatus.PENDING,
          page: 1,
          pageSize: 8,
        },
        CLINIC,
      );
      expect(accessClient.checkAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          petId: PET_ID,
          requiredScopes: ['medical_write'],
        }),
      );
      expect(prisma.draftReview.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC_ID,
        petId: { in: [PET_ID] },
        status: DraftReviewStatus.PENDING,
      });
    });

    it('petId yoksa tüm sayfalardaki aktif medical_write rızalı hayvanlar alınır', async () => {
      accessClient.listMyConsents
        .mockReturnValueOnce(
          of({
            consents: [
              consent(PET_ID, ['medical_write']),
              consent('okuma', ['medical_read']),
              consent('iptal', ['medical_write'], access.ConsentStatus.REVOKED),
            ],
            total: 130,
          }),
        )
        .mockReturnValueOnce(
          of({
            consents: [consent(OTHER_PET_ID, ['medical_write'])],
            total: 130,
          }),
        );

      await service.listDraftReviews({ page: 1, pageSize: 8 }, CLINIC);

      expect(accessClient.listMyConsents).toHaveBeenNthCalledWith(1, {
        page: 1,
        pageSize: 128,
      });
      expect(accessClient.listMyConsents).toHaveBeenNthCalledWith(2, {
        page: 2,
        pageSize: 128,
      });
      expect(prisma.draftReview.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC_ID,
        petId: { in: [PET_ID, OTHER_PET_ID] },
      });
    });

    it('rızalı hayvan yoksa veritabanına gidilmeden boş liste döner', async () => {
      await expect(
        service.listDraftReviews({ page: 1, pageSize: 8 }, CLINIC),
      ).resolves.toEqual({ draftReviews: [], total: 0, page: 1, pageSize: 8 });
      expect(prisma.draftReview.findMany).not.toHaveBeenCalled();
    });

    it('petId için rıza yoksa FORBIDDEN', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(
          service.listDraftReviews(
            { petId: PET_ID, page: 1, pageSize: 8 },
            CLINIC,
          ),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
    });
  });

  // ---Amaç: taslak onayının ve reddinin kurallarını, transaction içeriğini ve çakışma korumasını doğrulamak ---
  describe('reviewDraft', () => {
    const review = (over: Partial<ReviewDraftRequestDto>) =>
      ({
        id: DRAFT_ID,
        approved: true,
        reviewNote: '',
        editedContent: undefined,
        ...over,
      }) as ReviewDraftRequestDto;

    it.each([
      ['olmayan taslak', null],
      ['başka kliniğin taslağı', draftRow({ clinicId: OTHER_CLINIC_ID })],
    ])('%s → NOT_FOUND', async (_n, row) => {
      prisma.draftReview.findUnique.mockResolvedValue(row);
      expect(
        await rejectionMessage(service.reviewDraft(review({}), CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('medical_write yoksa FORBIDDEN', async () => {
      accessClient.checkAccess.mockReturnValue(allowed(false));
      expect(
        await rejectionMessage(service.reviewDraft(review({}), CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
    });

    it('PENDING olmayan taslak → CONFLICT', async () => {
      prisma.draftReview.findUnique.mockResolvedValue(
        draftRow({ status: DraftReviewStatus.APPROVED }),
      );
      expect(
        await rejectionMessage(service.reviewDraft(review({}), CLINIC)),
      ).toBe(ResponseMessages.CONFLICT);
      expect(prisma.draftReview.updateMany).not.toHaveBeenCalled();
    });

    it('red: not ve inceleyen klinik yazılır, kayıt oluşmaz', async () => {
      await service.reviewDraft(
        review({ approved: false, reviewNote: 'Yanlış belge' }),
        CLINIC,
      );
      expect(prisma.draftReview.updateMany).toHaveBeenCalledWith({
        where: { id: DRAFT_ID, status: DraftReviewStatus.PENDING },
        data: {
          reviewNote: 'Yanlış belge',
          reviewedByClinicId: CLINIC_ID,
          reviewedAt: expect.any(Date),
          status: DraftReviewStatus.REJECTED,
        },
      });
      expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
    });

    it('red sırasında başka biri incelediyse CONFLICT', async () => {
      prisma.draftReview.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await rejectionMessage(
          service.reviewDraft(
            review({ approved: false, reviewNote: 'x' }),
            CLINIC,
          ),
        ),
      ).toBe(ResponseMessages.CONFLICT);
    });

    it('düzeltmesiz onay: öneri kayda dönüşür, kaynak belge eklenir', async () => {
      prisma.medicalRecord.create.mockResolvedValue({ id: 'kayit-9' });
      const response = await service.reviewDraft(review({}), CLINIC);

      const [{ data: approveData }] =
        prisma.draftReview.updateMany.mock.calls[0];
      expect(approveData).toMatchObject({
        status: DraftReviewStatus.APPROVED,
        reviewedByClinicId: CLINIC_ID,
      });
      expect(approveData).not.toHaveProperty('approvedPayload');
      expect(prisma.medicalRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: RecordType.VACCINATION,
            petId: PET_ID,
            clinicId: CLINIC_ID,
            sourceDocumentId: DOC_ID,
            sourceDraftReviewId: DRAFT_ID,
            attachments: { create: [{ documentId: DOC_ID }] },
          }),
        }),
      );
      expect(prisma.draftReview.update).toHaveBeenCalledWith({
        where: { id: DRAFT_ID },
        data: { createdRecordId: 'kayit-9' },
      });
      expect(response.draftReview?.id).toBe(DRAFT_ID);
    });

    it('geçersiz AI önerisi düzeltmesiz onaylanamaz, alan hatası döner', async () => {
      prisma.draftReview.findUnique.mockResolvedValue(
        draftRow({ proposedPayload: { ...PROPOSAL, title: '' } }),
      );
      expect(
        await rejectionMessage(service.reviewDraft(review({}), CLINIC)),
      ).toBe('TITLE_NOT_EMPTY');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('düzelterek onay: tür değişebilir, düzeltilmiş içerik saklanır', async () => {
      prisma.medicalRecord.create.mockResolvedValue({ id: 'kayit-9' });
      const editedContent = {
        type: medicalRecord.RecordType.SURGERY,
        title: '  Kısırlaştırma  ',
        recordedAt: '2026-10-12',
      };
      await service.reviewDraft(
        review({
          editedContent:
            editedContent as ReviewDraftRequestDto['editedContent'],
        }),
        CLINIC,
      );
      const [{ data }] = prisma.draftReview.updateMany.mock.calls[0];
      expect(data.approvedPayload).toEqual({
        type: medicalRecord.RecordType.SURGERY,
        title: 'Kısırlaştırma',
        recordedAt: '2026-10-12',
      });
      expect(prisma.medicalRecord.create.mock.calls[0][0].data.type).toBe(
        RecordType.SURGERY,
      );
    });

    it('onay sırasında başka biri incelediyse CONFLICT, kayıt oluşmaz', async () => {
      prisma.draftReview.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await rejectionMessage(service.reviewDraft(review({}), CLINIC)),
      ).toBe(ResponseMessages.CONFLICT);
      expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
    });
  });
});
