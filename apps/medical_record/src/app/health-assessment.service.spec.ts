jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { access, medicalRecord } from '@libs/proto';
import { AuthUser, ResponseMessages } from '@libs/common';
import { todayInBusinessTimeZone } from '@libs/dto';
import {
  HealthAssessmentStatus,
  HealthRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import { MedicalRecordService } from './medical-record.service';
import { PrismaService } from './prisma/prisma.service';
import { buildHealthAssessmentSnapshot } from './health-assessment.snapshot';

const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const OWNER_ID = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const ROW_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const OLD_REQUEST_ID = 'c4a1e9d2-3b5f-4a7c-8e6d-1f2a3b4c5d6e';
const MINUTE = 60 * 1000;

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

const LAB_ROWS = [
  {
    id: 'l1',
    recordId: 'kayit-1',
    testName: 'HCT',
    value: '32',
    unit: '%',
    referenceRange: '37-55',
    flag: null,
    sampledAt: new Date('2026-10-28T00:00:00.000Z'),
  },
];

const clientGrpcFor = (implementation: unknown): ClientGrpc =>
  ({ getService: () => implementation }) as unknown as ClientGrpc;

// ---Amaç: servisin fırlattığı RpcException mesajını yakalamak ---
const rejectionMessage = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).message;
};

// ---Amaç: veritabanındaki değerlendirme satırını üretmek ---
const assessmentRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  petId: PET_ID,
  requestId: OLD_REQUEST_ID,
  status: HealthAssessmentStatus.PENDING,
  inputHash: 'eski'.padEnd(64, '0'),
  basedOnRecordIds: ['kayit-1'],
  requestedByUserId: OWNER_ID,
  summary: null,
  riskLevel: null,
  payload: null,
  confidence: null,
  modelVersion: null,
  failureReason: null,
  requestedAt: new Date(),
  generatedAt: null,
  ...over,
});

describe('MedicalRecordService sağlık değerlendirmesi', () => {
  let service: MedicalRecordService;
  let prisma: {
    labResult: { findMany: jest.Mock };
    vaccination: { findMany: jest.Mock };
    prescription: { findMany: jest.Mock };
    medicalRecord: { findMany: jest.Mock };
    healthAssessment: {
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    outbox: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let accessClient: { checkAccess: jest.Mock; listMyConsents: jest.Mock };
  let petsClient: { getPetOwner: jest.Mock; getPet: jest.Mock };
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let currentHash: string;

  const request = { petId: PET_ID };

  beforeEach(async () => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    prisma = {
      labResult: { findMany: jest.fn().mockResolvedValue(LAB_ROWS) },
      vaccination: { findMany: jest.fn().mockResolvedValue([]) },
      prescription: { findMany: jest.fn().mockResolvedValue([]) },
      medicalRecord: { findMany: jest.fn().mockResolvedValue([]) },
      healthAssessment: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(assessmentRow()),
      },
      outbox: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    accessClient = {
      checkAccess: jest.fn().mockReturnValue(of({ allowed: true })),
      listMyConsents: jest.fn(),
    };
    petsClient = {
      getPetOwner: jest
        .fn()
        .mockReturnValue(of({ petId: PET_ID, ownerUserId: OWNER_ID })),
      getPet: jest.fn().mockReturnValue(
        of({
          pet: {
            id: PET_ID,
            species: 'DOG',
            breed: 'GOLDEN_RETRIEVER',
            sex: 2,
            birthDate: '2023-04-10',
            isBirthDateEstimated: false,
            isNeutered: true,
          },
        }),
      ),
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

    currentHash = (
      await buildHealthAssessmentSnapshot(
        prisma as unknown as PrismaService,
        PET_ID,
        todayInBusinessTimeZone(),
      )
    ).inputHash;
  });

  afterEach(() => jest.restoreAllMocks());

  describe('requestHealthAssessment', () => {
    it('ilk istekte satır ve outbox olayı aynı transaction içinde yazılır', async () => {
      prisma.healthAssessment.findUniqueOrThrow.mockResolvedValue(
        assessmentRow({ inputHash: currentHash }),
      );

      const response = await service.requestHealthAssessment(request, OWNER);

      expect(petsClient.getPetOwner).toHaveBeenCalledWith({ petId: PET_ID });
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
      const [{ data }] = prisma.healthAssessment.create.mock.calls[0];
      expect(data).toMatchObject({
        petId: PET_ID,
        status: HealthAssessmentStatus.PENDING,
        inputHash: currentHash,
        basedOnRecordIds: ['kayit-1'],
        requestedByUserId: OWNER_ID,
        payload: Prisma.DbNull,
      });
      const [{ data: outbox }] = prisma.outbox.create.mock.calls[0];
      expect(outbox.type).toBe(
        'com.patipasaport.health_assessment.requested.v1',
      );
      expect(outbox.payload.subject).toBe(data.requestId);
      expect(outbox.payload.data).toMatchObject({
        requestId: data.requestId,
        asOf: todayInBusinessTimeZone(),
        species: 'DOG',
        breed: 'GOLDEN_RETRIEVER',
        sex: 'FEMALE',
        isNeutered: true,
        birthDate: '2023-04-10',
        labSeries: [{ testName: 'HCT' }],
      });
      expect(response).toMatchObject({
        status: medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_PENDING,
        isStale: false,
        assessment: undefined,
      });
    });

    it('klinik medical_read onayıyla isteyebilir', async () => {
      await service.requestHealthAssessment(request, CLINIC);
      expect(accessClient.checkAccess).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        requiredScopes: ['medical_read'],
      });
      expect(prisma.healthAssessment.create).toHaveBeenCalled();
    });

    it('onayı olmayan klinik FORBIDDEN alır', async () => {
      accessClient.checkAccess.mockReturnValue(of({ allowed: false }));
      expect(
        await rejectionMessage(
          service.requestHealthAssessment(request, CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.healthAssessment.create).not.toHaveBeenCalled();
    });

    it('başkasının hayvanı NOT_FOUND alır', async () => {
      petsClient.getPetOwner.mockReturnValue(
        of({ petId: PET_ID, ownerUserId: CLINIC.userId }),
      );
      expect(
        await rejectionMessage(service.requestHealthAssessment(request, OWNER)),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('değerlendirilecek kayıt yoksa HEALTH_ASSESSMENT_NO_RECORDS döner', async () => {
      prisma.labResult.findMany.mockResolvedValue([]);
      expect(
        await rejectionMessage(service.requestHealthAssessment(request, OWNER)),
      ).toBe(ResponseMessages.HEALTH_ASSESSMENT_NO_RECORDS);
      expect(prisma.healthAssessment.findUnique).not.toHaveBeenCalled();
    });

    it('pets yanıt vermezse istek hayvan bilgileri olmadan yazılır', async () => {
      petsClient.getPet.mockReturnValue(throwError(() => new Error('kapalı')));
      await service.requestHealthAssessment(request, OWNER);
      const [{ data: outbox }] = prisma.outbox.create.mock.calls[0];
      expect(outbox.payload.data.species).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('pets.getPet başarısız'),
      );
    });

    it.each([
      ['yeni PENDING', assessmentRow()],
      [
        'kayıtları değişmemiş READY',
        () =>
          assessmentRow({
            status: HealthAssessmentStatus.READY,
            inputHash: currentHash,
            requestedAt: new Date(Date.now() - 60 * MINUTE),
          }),
      ],
    ])('%s mevcut satırla döner, AI yeniden çağrılmaz', async (_label, row) => {
      prisma.healthAssessment.findUnique.mockResolvedValue(
        typeof row === 'function' ? row() : row,
      );
      await service.requestHealthAssessment(request, OWNER);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(petsClient.getPet).not.toHaveBeenCalled();
    });

    it.each([
      [HealthAssessmentStatus.READY, 5],
      [HealthAssessmentStatus.FAILED, 9],
    ])(
      '%s satırda son istekten %p dakika sonra HEALTH_ASSESSMENT_TOO_SOON döner',
      async (status, minutes) => {
        prisma.healthAssessment.findUnique.mockResolvedValue(
          assessmentRow({
            status,
            requestedAt: new Date(Date.now() - minutes * MINUTE),
          }),
        );
        expect(
          await rejectionMessage(
            service.requestHealthAssessment(request, OWNER),
          ),
        ).toBe(ResponseMessages.HEALTH_ASSESSMENT_TOO_SOON);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each([
      [HealthAssessmentStatus.READY, 11],
      [HealthAssessmentStatus.FAILED, 10],
      [HealthAssessmentStatus.PENDING, 30],
    ])(
      '%s satırda %p dakika sonra yeni istek eski satırın üzerine yazılır',
      async (status, minutes) => {
        prisma.healthAssessment.findUnique.mockResolvedValue(
          assessmentRow({
            status,
            requestedAt: new Date(Date.now() - minutes * MINUTE),
          }),
        );
        await service.requestHealthAssessment(request, OWNER);

        const [{ where, data }] =
          prisma.healthAssessment.updateMany.mock.calls[0];
        expect(where).toEqual({ id: ROW_ID, requestId: OLD_REQUEST_ID });
        expect(data).toMatchObject({
          status: HealthAssessmentStatus.PENDING,
          inputHash: currentHash,
          summary: null,
          riskLevel: null,
          confidence: null,
          failureReason: null,
          generatedAt: null,
        });
        expect(data.requestId).not.toBe(OLD_REQUEST_ID);
        expect(prisma.outbox.create).toHaveBeenCalled();
      },
    );

    it('eş zamanlı güncellemede outbox yazılmaz, güncel satır döner', async () => {
      prisma.healthAssessment.findUnique.mockResolvedValue(
        assessmentRow({
          status: HealthAssessmentStatus.FAILED,
          requestedAt: new Date(Date.now() - 20 * MINUTE),
        }),
      );
      prisma.healthAssessment.updateMany.mockResolvedValue({ count: 0 });

      await service.requestHealthAssessment(request, OWNER);

      expect(prisma.outbox.create).not.toHaveBeenCalled();
      expect(prisma.healthAssessment.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { petId: PET_ID },
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('eş zamanlı istek'),
      );
    });

    it('eş zamanlı ilk istekte benzersizlik hatası güncel satırla karşılanır', async () => {
      prisma.healthAssessment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.requestHealthAssessment(request, OWNER),
      ).resolves.toMatchObject({
        status: medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_PENDING,
      });
    });

    it('başka veritabanı hataları yukarı iletilir', async () => {
      prisma.healthAssessment.create.mockRejectedValue(new Error('bağlantı'));
      await expect(
        service.requestHealthAssessment(request, OWNER),
      ).rejects.toThrow('bağlantı');
    });
  });

  describe('getLatestHealthAssessment', () => {
    it('değerlendirme yoksa NOT_FOUND döner', async () => {
      expect(
        await rejectionMessage(
          service.getLatestHealthAssessment(request, OWNER),
        ),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('hazır değerlendirme içerik, güven ve zamanlarla döner', async () => {
      const requestedAt = new Date('2026-11-01T10:14:00.000Z');
      const generatedAt = new Date('2026-11-01T10:15:00.000Z');
      prisma.healthAssessment.findUnique.mockResolvedValue(
        assessmentRow({
          status: HealthAssessmentStatus.READY,
          inputHash: currentHash,
          summary: 'Hematokrit düşüyor.',
          riskLevel: HealthRiskLevel.HIGH,
          payload: {
            findings: [
              {
                testName: 'HCT',
                trend: 'LAB_TREND_FALLING',
                interpretation: 'Azalmış.',
              },
            ],
            vaccinationReminders: [
              {
                vaccineName: 'Kuduz',
                nextDueAt: '2026-10-05',
                status: 'VACCINATION_OVERDUE',
              },
            ],
          },
          confidence: 0.71,
          requestedAt,
          generatedAt,
        }),
      );

      await expect(
        service.getLatestHealthAssessment(request, CLINIC),
      ).resolves.toEqual({
        status: medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_READY,
        assessment: {
          summary: 'Hematokrit düşüyor.',
          riskLevel: medicalRecord.HealthRiskLevel.HEALTH_RISK_HIGH,
          findings: [
            {
              testName: 'HCT',
              trend: medicalRecord.LabTrend.LAB_TREND_FALLING,
              interpretation: 'Azalmış.',
            },
          ],
          possibleConditions: [],
          recommendations: [],
          vaccinationReminders: [
            {
              vaccineName: 'Kuduz',
              nextDueAt: '2026-10-05',
              status: medicalRecord.VaccinationDueStatus.VACCINATION_OVERDUE,
            },
          ],
          questionsForVet: [],
        },
        confidence: 0.71,
        requestedAt: requestedAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        isStale: false,
      });
      expect(accessClient.checkAccess).toHaveBeenCalled();
    });

    it('kayıtlar değiştiyse isStale true döner; başarısız satır içeriksiz döner', async () => {
      prisma.healthAssessment.findUnique.mockResolvedValue(
        assessmentRow({
          status: HealthAssessmentStatus.FAILED,
          failureReason: 'INVALID_AI_OUTPUT',
        }),
      );
      await expect(
        service.getLatestHealthAssessment(request, OWNER),
      ).resolves.toMatchObject({
        status: medicalRecord.HealthAssessmentStatus.HEALTH_ASSESSMENT_FAILED,
        assessment: undefined,
        confidence: 0,
        generatedAt: '',
        isStale: true,
      });
    });
  });
});
