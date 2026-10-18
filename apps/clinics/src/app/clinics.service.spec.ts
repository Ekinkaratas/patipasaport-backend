jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { access, clinics, medicalRecord, pets } from '@libs/proto';
import { AuthUser, ResponseMessages } from '@libs/common';
import { ClinicsService } from './clinics.service';
import { PrismaService } from './prisma/prisma.service';
import { RECENT_RECORD_LIMIT } from './clinics.constants';
import {
  Clinic,
  Prisma,
  StockCategory,
  StockItem,
  StockSale,
  StockUnit,
} from '../generated/prisma/client';

const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const OTHER_CLINIC_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CLINIC_USER_ID = '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c';
const OWNER_ID = '8f9e0d1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const STOCK_ID = '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c';
const ACCOUNT_ID = '4d5e6f70-8192-4a3b-9c4d-5e6f708192a3';
const TAX = '4540536920';

const CLINIC: AuthUser = {
  userId: CLINIC_USER_ID,
  role: 'CLINIC',
  clinicId: CLINIC_ID,
  clientType: access.ClientType.WEB,
};

const OTHER_CLINIC: AuthUser = { ...CLINIC, clinicId: OTHER_CLINIC_ID };

const OWNER: AuthUser = {
  userId: OWNER_ID,
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
};

// ---Amaç: veritabanından dönen klinik satırını üretmek ---
const clinicRow = (over: Partial<Clinic> = {}): Clinic => ({
  id: CLINIC_ID,
  fullName: 'Pati Klinik',
  taxNumber: TAX,
  contactEmail: 'klinik@pati.test',
  telNo: '+902161234567',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

// ---Amaç: veritabanından dönen stok satırını üretmek ---
const stockRow = (over: Partial<StockItem> = {}): StockItem => ({
  id: STOCK_ID,
  clinicId: CLINIC_ID,
  name: 'Amoksisilin',
  category: StockCategory.MEDICINE,
  unit: StockUnit.BOX,
  quantity: 10,
  criticalLevel: 2,
  expiresAt: new Date('2027-03-01T00:00:00.000Z'),
  purchasePrice: 8_000,
  salePrice: 12_000,
  createdBy: CLINIC_USER_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

const SALE_ID = '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4';

const saleRow = (over: Partial<StockSale> = {}): StockSale => ({
  id: SALE_ID,
  clinicId: CLINIC_ID,
  stockItemId: STOCK_ID,
  itemName: 'Amoksisilin',
  category: StockCategory.MEDICINE,
  unit: StockUnit.BOX,
  quantity: 3,
  unitSalePrice: 12_000,
  unitPurchasePrice: 8_000,
  soldAt: new Date(),
  cancelledAt: null,
  createdBy: CLINIC_USER_ID,
  ...over,
});

// ---Amaç: pets.GetPet yanıtındaki hayvanı üretmek ---
const petMessage = (over: Partial<pets.Pet> = {}): pets.Pet => ({
  id: PET_ID,
  name: 'Boncuk',
  species: 'DOG',
  breed: 'KANGAL',
  sex: pets.PetSex.MALE,
  birthDate: '2022-05-10',
  isBirthDateEstimated: false,
  isNeutered: true,
  ownerUserId: OWNER_ID,
  chipNumberMasked: '****3444',
  chipNumber: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

// ---Amaç: medical_record.RegisterDocument yanıtındaki belgeyi üretmek ---
const documentMessage = (
  over: Partial<medicalRecord.Document> = {},
): medicalRecord.Document => ({
  id: 'belge-1',
  petId: PET_ID,
  clinicId: CLINIC_ID,
  storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
  originalName: 'Kan Tahlili.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  note: '',
  status: medicalRecord.DocumentStatus.QUEUED,
  failureReason: '',
  draftReviewId: '',
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
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

const CREATE_REQUEST: clinics.CreateClinicRequest = {
  name: 'Pati Klinik',
  taxNumber: TAX,
  phone: '+902161234567',
  email: 'klinik@pati.test',
  password: 'Abcdef1!',
};

describe('ClinicsService', () => {
  let service: ClinicsService;
  let prisma: {
    clinic: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    stockItem: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
      fields: { criticalLevel: string };
    };
    stockSale: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let petsClient: { getPet: jest.Mock };
  let usersClient: { getUserContact: jest.Mock; deactivateClinicUsers: jest.Mock };
  let medicalRecordClient: {
    listRecordsByPet: jest.Mock;
    listDraftReviews: jest.Mock;
    registerDocument: jest.Mock;
  };
  let authClient: { registerClinicAccount: jest.Mock };

  beforeEach(async () => {
    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue(clinicRow()),
        create: jest.fn().mockResolvedValue(clinicRow()),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Partial<Clinic> }) =>
            Promise.resolve(clinicRow(data)),
          ),
        delete: jest.fn().mockResolvedValue(clinicRow()),
      },
      stockItem: {
        create: jest.fn().mockResolvedValue(stockRow()),
        findMany: jest.fn().mockResolvedValue([stockRow()]),
        findFirst: jest.fn().mockResolvedValue(stockRow()),
        findUnique: jest.fn().mockResolvedValue(stockRow({ quantity: 13 })),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(stockRow({ quantity: 7 })),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue(stockRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue(stockRow()),
        fields: { criticalLevel: 'criticalLevel-alan-referansi' },
      },
      stockSale: {
        create: jest.fn().mockResolvedValue(saleRow()),
        findFirst: jest.fn().mockResolvedValue(saleRow()),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(saleRow({ cancelledAt: new Date() })),
        findMany: jest.fn().mockResolvedValue([saleRow()]),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    petsClient = {
      getPet: jest.fn().mockReturnValue(of({ pet: petMessage() })),
    };
    usersClient = {
      getUserContact: jest.fn().mockReturnValue(
        of({
          userId: OWNER_ID,
          fullName: 'Ayşe Yılmaz',
          phone: '+905551234567',
          email: 'ayse@pati.test',
        }),
      ),
      deactivateClinicUsers: jest
        .fn()
        .mockReturnValue(of({ deactivatedCount: 1 })),
    };
    medicalRecordClient = {
      listRecordsByPet: jest.fn().mockReturnValue(
        of({
          records: [
            {
              id: 'kayit-1',
              type: medicalRecord.RecordType.VACCINATION,
              title: 'Kuduz aşısı',
              recordedAt: '2026-02-01T10:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: RECENT_RECORD_LIMIT,
        }),
      ),
      listDraftReviews: jest
        .fn()
        .mockReturnValue(
          of({ draftReviews: [], total: 3, page: 1, pageSize: 8 }),
        ),
      registerDocument: jest
        .fn()
        .mockReturnValue(of({ document: documentMessage() })),
    };
    authClient = {
      registerClinicAccount: jest
        .fn()
        .mockReturnValue(of({ userId: ACCOUNT_ID })),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'PETS_SERVICE', useValue: clientGrpcFor(petsClient) },
        { provide: 'USERS_SERVICE', useValue: clientGrpcFor(usersClient) },
        {
          provide: 'MEDICAL_RECORD_SERVICE',
          useValue: clientGrpcFor(medicalRecordClient),
        },
        { provide: 'AUTH_SERVICE', useValue: clientGrpcFor(authClient) },
      ],
    }).compile();

    service = moduleRef.get(ClinicsService);
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  // ---Amaç: klinik profilinin alanlarını ve vergi numarasının yalnızca kliniğin kendisine tam gösterildiğini doğrulamak ---
  describe('getClinic', () => {
    it('kendi kliniğine tüm alanları tam vergi numarasıyla döner', async () => {
      await expect(service.getClinic({ id: CLINIC_ID }, CLINIC)).resolves.toEqual(
        {
          clinic: {
            id: CLINIC_ID,
            name: 'Pati Klinik',
            taxNumber: TAX,
            phone: '+902161234567',
            email: 'klinik@pati.test',
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        },
      );
    });

    it.each([
      ['başka klinik', OTHER_CLINIC],
      ['hasta sahibi', OWNER],
    ])('%s vergi numarasının yalnızca son 4 hanesini görür', async (_n, user) => {
      const { clinic } = await service.getClinic({ id: CLINIC_ID }, user);
      expect(clinic?.taxNumber).toBe(TAX.slice(-4));
    });

    it('klinik yoksa NOT_FOUND', async () => {
      prisma.clinic.findUnique.mockResolvedValue(null);
      expect(
        await rejectionMessage(service.getClinic({ id: CLINIC_ID }, CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
    });
  });

  // ---Amaç: klinik satırının ve ortak hesabın birlikte açıldığını, hatada satırın geri alındığını doğrulamak ---
  describe('createClinic', () => {
    it('klinik satırını yazar, auth ile hesabı açar ve tam kaydı döner', async () => {
      const result = await service.createClinic(CREATE_REQUEST);

      expect(prisma.clinic.create).toHaveBeenCalledWith({
        data: {
          fullName: 'Pati Klinik',
          taxNumber: TAX,
          contactEmail: 'klinik@pati.test',
          telNo: '+902161234567',
        },
      });
      expect(authClient.registerClinicAccount).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        email: 'klinik@pati.test',
        password: 'Abcdef1!',
        fullName: 'Pati Klinik',
        phone: '+902161234567',
      });
      expect(result.clinic).toMatchObject({
        id: CLINIC_ID,
        taxNumber: TAX,
        isActive: true,
      });
      expect(prisma.clinic.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['clinics_tax_number_key', ResponseMessages.TAX_NUMBER_ALREADY_EXISTS],
      ['clinics_contact_email_key', ResponseMessages.EMAIL_ALREADY_EXISTS],
      ['clinics_tel_no_key', ResponseMessages.PHONE_ALREADY_EXISTS],
      ['clinics_pkey', ResponseMessages.INTERNAL_SERVER_ERROR],
    ])(
      '%s çakışması %s olarak bildirilir ve auth çağrılmaz',
      async (index, expected) => {
        prisma.clinic.create.mockRejectedValue(prismaError('P2002', index));

        expect(await rejectionMessage(service.createClinic(CREATE_REQUEST))).toBe(
          expected,
        );
        expect(authClient.registerClinicAccount).not.toHaveBeenCalled();
      },
    );

    it('unique dışı veritabanı hatası olduğu gibi yükselir', async () => {
      const error = new Error('bağlantı koptu');
      prisma.clinic.create.mockRejectedValue(error);

      await expect(service.createClinic(CREATE_REQUEST)).rejects.toBe(error);
    });

    it.each([
      [
        'e-posta kullanıcıda kayıtlı',
        grpcError(status.ALREADY_EXISTS, ResponseMessages.EMAIL_ALREADY_EXISTS),
        ResponseMessages.EMAIL_ALREADY_EXISTS,
      ],
      [
        'telefon kullanıcıda kayıtlı',
        grpcError(status.ALREADY_EXISTS, ResponseMessages.PHONE_ALREADY_EXISTS),
        ResponseMessages.PHONE_ALREADY_EXISTS,
      ],
      [
        'auth ulaşılamıyor',
        grpcError(status.UNAVAILABLE),
        ResponseMessages.SERVICE_UNAVAILABLE,
      ],
      [
        'auth beklenmeyen hata',
        grpcError(status.INTERNAL, ResponseMessages.INTERNAL_SERVER_ERROR),
        ResponseMessages.INTERNAL_SERVER_ERROR,
      ],
    ])('%s: klinik satırı silinir, %s döner', async (_n, error, expected) => {
      authClient.registerClinicAccount.mockReturnValue(throwError(() => error));

      expect(await rejectionMessage(service.createClinic(CREATE_REQUEST))).toBe(
        expected,
      );
      expect(prisma.clinic.delete).toHaveBeenCalledWith({
        where: { id: CLINIC_ID },
      });
    });

    it('auth zaman aşımında sahipsiz hesap ihtimali error loguna yazılır, satır yine silinir', async () => {
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      authClient.registerClinicAccount.mockReturnValue(
        throwError(() => grpcError(status.DEADLINE_EXCEEDED)),
      );

      expect(await rejectionMessage(service.createClinic(CREATE_REQUEST))).toBe(
        ResponseMessages.SERVICE_UNAVAILABLE,
      );
      expect(prisma.clinic.delete).toHaveBeenCalled();
      expect(
        errorLog.mock.calls.some(([message]) =>
          String(message).includes('sahipsiz'),
        ),
      ).toBe(true);
    });

    it('geri alma da başarısız olursa istemciye yine auth hatası döner', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.clinic.delete.mockRejectedValue(new Error('silinemedi'));
      authClient.registerClinicAccount.mockReturnValue(
        throwError(() =>
          grpcError(status.ALREADY_EXISTS, ResponseMessages.EMAIL_ALREADY_EXISTS),
        ),
      );

      expect(await rejectionMessage(service.createClinic(CREATE_REQUEST))).toBe(
        ResponseMessages.EMAIL_ALREADY_EXISTS,
      );
    });
  });

  // ---Amaç: kliniğin kendini pasifleştirmesinde vergi numarasının anonimleştiğini ve ortak hesabın kapatıldığını doğrulamak ---
  describe('deactivateClinic', () => {
    it('başka kliniğin adına istek FORBIDDEN alır ve veritabanına gitmez', async () => {
      expect(
        await rejectionMessage(
          service.deactivateClinic({ clinicId: CLINIC_ID }, OTHER_CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.clinic.findUnique).not.toHaveBeenCalled();
    });

    it('klinik yoksa NOT_FOUND', async () => {
      prisma.clinic.findUnique.mockResolvedValue(null);
      expect(
        await rejectionMessage(
          service.deactivateClinic({ clinicId: CLINIC_ID }, CLINIC),
        ),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(usersClient.deactivateClinicUsers).not.toHaveBeenCalled();
    });

    it('aktif kliniği pasifleştirir, vergi numarasını X + 10 rakam yapar ve hesabı kapatır', async () => {
      const { clinic } = await service.deactivateClinic(
        { clinicId: CLINIC_ID },
        CLINIC,
      );

      const { where, data } = prisma.clinic.update.mock.calls[0][0];
      expect(where).toEqual({ id: CLINIC_ID });
      expect(data.isActive).toBe(false);
      expect(data.taxNumber).toMatch(/^X\d{10}$/);
      expect(Object.keys(data).sort()).toEqual(['isActive', 'taxNumber']);
      expect(usersClient.deactivateClinicUsers).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
      });
      expect(clinic).toMatchObject({
        isActive: false,
        taxNumber: data.taxNumber,
        name: 'Pati Klinik',
        email: 'klinik@pati.test',
        phone: '+902161234567',
      });
    });

    it('anonim vergi numarası çakışırsa bir kez yeni değerle tekrar dener', async () => {
      prisma.clinic.update.mockRejectedValueOnce(
        prismaError('P2002', 'clinics_tax_number_key'),
      );

      const { clinic } = await service.deactivateClinic(
        { clinicId: CLINIC_ID },
        CLINIC,
      );

      expect(prisma.clinic.update).toHaveBeenCalledTimes(2);
      expect(clinic?.isActive).toBe(false);
    });

    it('ikinci denemede de çakışırsa hata yükselir ve hesap kapatılmaz', async () => {
      const collision = prismaError('P2002', 'clinics_tax_number_key');
      prisma.clinic.update.mockRejectedValue(collision);

      await expect(
        service.deactivateClinic({ clinicId: CLINIC_ID }, CLINIC),
      ).rejects.toBe(collision);
      expect(prisma.clinic.update).toHaveBeenCalledTimes(2);
      expect(usersClient.deactivateClinicUsers).not.toHaveBeenCalled();
    });

    it('vergi numarası dışındaki hatada tekrar denemez', async () => {
      const error = prismaError('P2002', 'clinics_tel_no_key');
      prisma.clinic.update.mockRejectedValue(error);

      await expect(
        service.deactivateClinic({ clinicId: CLINIC_ID }, CLINIC),
      ).rejects.toBe(error);
      expect(prisma.clinic.update).toHaveBeenCalledTimes(1);
    });

    it('zaten pasif klinikte vergi numarasına dokunmaz, yalnızca hesabı kapatır', async () => {
      prisma.clinic.findUnique.mockResolvedValue(
        clinicRow({ isActive: false, taxNumber: 'X1234567890' }),
      );

      const { clinic } = await service.deactivateClinic(
        { clinicId: CLINIC_ID },
        CLINIC,
      );

      expect(prisma.clinic.update).not.toHaveBeenCalled();
      expect(usersClient.deactivateClinicUsers).toHaveBeenCalledTimes(1);
      expect(clinic?.taxNumber).toBe('X1234567890');
    });

    it('users ulaşılamazsa SERVICE_UNAVAILABLE', async () => {
      usersClient.deactivateClinicUsers.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      expect(
        await rejectionMessage(
          service.deactivateClinic({ clinicId: CLINIC_ID }, CLINIC),
        ),
      ).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });
  });

  // ---Amaç: stok eklemenin sahiplik/aktiflik kontrollerini, alan dönüşümünü ve created_by'ı doğrulamak ---
  describe('addStockItem', () => {
    const request: clinics.AddStockItemRequest = {
      clinicId: CLINIC_ID,
      name: 'Amoksisilin',
      category: 'MEDICINE',
      unit: 'BOX',
      quantity: 10,
      criticalLevel: 2,
      expiresAt: '2027-03-01',
      purchasePrice: 8_000,
      salePrice: 12_000,
    };

    it('kalemi fiyatlarıyla ve JWT kullanıcısıyla yazar, proto biçiminde döner', async () => {
      const { item } = await service.addStockItem(request, CLINIC);

      expect(prisma.stockItem.create).toHaveBeenCalledWith({
        data: {
          clinicId: CLINIC_ID,
          name: 'Amoksisilin',
          category: 'MEDICINE',
          unit: 'BOX',
          quantity: 10,
          criticalLevel: 2,
          expiresAt: new Date('2027-03-01'),
          purchasePrice: 8_000,
          salePrice: 12_000,
          createdBy: CLINIC_USER_ID,
        },
      });
      expect(item).toEqual({
        id: STOCK_ID,
        clinicId: CLINIC_ID,
        name: 'Amoksisilin',
        category: 'MEDICINE',
        unit: 'BOX',
        quantity: 10,
        criticalLevel: 2,
        isBelowCritical: false,
        expiresAt: '2027-03-01',
        updatedAt: '2026-01-02T00:00:00.000Z',
        purchasePrice: 8_000,
        salePrice: 12_000,
      });
    });

    it('fiyatı tanımsız eski kalemde fiyatlar yanıtta yer almaz', async () => {
      prisma.stockItem.create.mockResolvedValue(
        stockRow({ purchasePrice: null, salePrice: null }),
      );

      const { item } = await service.addStockItem(request, CLINIC);

      expect(item?.purchasePrice).toBeUndefined();
      expect(item?.salePrice).toBeUndefined();
    });

    it('boş SKT null yazılır; kritik seviye altı hesaplanır', async () => {
      prisma.stockItem.create.mockResolvedValue(
        stockRow({ expiresAt: null, quantity: 1, criticalLevel: 5 }),
      );

      const { item } = await service.addStockItem(
        { ...request, expiresAt: '' },
        CLINIC,
      );

      expect(prisma.stockItem.create.mock.calls[0][0].data.expiresAt).toBeNull();
      expect(item).toMatchObject({ expiresAt: '', isBelowCritical: true });
    });

    it('başka kliniğin adına FORBIDDEN, kayıtsız klinik NOT_FOUND, pasif klinik FORBIDDEN', async () => {
      expect(
        await rejectionMessage(service.addStockItem(request, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);

      prisma.clinic.findUnique.mockResolvedValueOnce(null);
      expect(await rejectionMessage(service.addStockItem(request, CLINIC))).toBe(
        ResponseMessages.NOT_FOUND,
      );

      prisma.clinic.findUnique.mockResolvedValueOnce(
        clinicRow({ isActive: false }),
      );
      expect(await rejectionMessage(service.addStockItem(request, CLINIC))).toBe(
        ResponseMessages.FORBIDDEN,
      );
      expect(prisma.stockItem.create).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: stok listesinin filtre, sıralama ve sayfalama sorgusunu doğru kurduğunu doğrulamak ---
  describe('listStockItems', () => {
    it('filtresiz istekte yalnızca klinik koşulu, ad → SKT → id sıralaması ve sayfa ofseti kullanılır', async () => {
      const result = await service.listStockItems(
        { clinicId: CLINIC_ID, page: 2, pageSize: 8 },
        CLINIC,
      );

      expect(prisma.stockItem.findMany).toHaveBeenCalledWith({
        where: { clinicId: CLINIC_ID },
        orderBy: [
          { name: 'asc' },
          { expiresAt: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        skip: 8,
        take: 8,
      });
      expect(prisma.stockItem.count).toHaveBeenCalledWith({
        where: { clinicId: CLINIC_ID },
      });
      expect(result).toMatchObject({ total: 1, page: 2, pageSize: 8 });
      expect(result.items).toHaveLength(1);
    });

    it('kategori ve kritik seviye filtreleri where koşuluna eklenir', async () => {
      await service.listStockItems(
        {
          clinicId: CLINIC_ID,
          category: 'VACCINE',
          onlyBelowCritical: true,
          page: 1,
          pageSize: 8,
        },
        CLINIC,
      );

      expect(prisma.stockItem.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC_ID,
        category: 'VACCINE',
        quantity: { lt: 'criticalLevel-alan-referansi' },
      });
    });

    it('pasif klinik listeleyemez', async () => {
      prisma.clinic.findUnique.mockResolvedValue(clinicRow({ isActive: false }));
      expect(
        await rejectionMessage(
          service.listStockItems(
            { clinicId: CLINIC_ID, page: 1, pageSize: 8 },
            CLINIC,
          ),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
    });
  });

  // ---Amaç: stok kaleminin yalnızca gönderilen alanlarla, kendi kliniğine sınırlı tek sorguda güncellendiğini doğrulamak ---
  describe('updateStockItem', () => {
    const base = { clinicId: CLINIC_ID, itemId: STOCK_ID };

    it('yalnızca gönderilen alanlar yazılır ve sorgu kendi kliniğinin kalemiyle sınırlıdır', async () => {
      prisma.stockItem.update.mockResolvedValue(
        stockRow({ name: 'Amoksisilin 500', quantity: 4, criticalLevel: 5 }),
      );

      const { item } = await service.updateStockItem(
        { ...base, name: 'Amoksisilin 500', quantity: 4, criticalLevel: 5 },
        CLINIC,
      );

      expect(prisma.stockItem.update).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID },
        data: { name: 'Amoksisilin 500', quantity: 4, criticalLevel: 5 },
      });
      expect(item).toMatchObject({
        name: 'Amoksisilin 500',
        quantity: 4,
        isBelowCritical: true,
      });
    });

    it('alış ve satış fiyatları gönderilirse yazılır', async () => {
      await service.updateStockItem(
        { ...base, purchasePrice: 9_000, salePrice: 0 },
        CLINIC,
      );

      expect(prisma.stockItem.update.mock.calls[0][0].data).toEqual({
        purchasePrice: 9_000,
        salePrice: 0,
      });
    });

    it('boş tarih son kullanma tarihini kaldırır, yeni tarih Date olarak yazılır', async () => {
      await service.updateStockItem({ ...base, expiresAt: '' }, CLINIC);
      await service.updateStockItem(
        { ...base, expiresAt: '2027-05-01' },
        CLINIC,
      );

      expect(prisma.stockItem.update.mock.calls[0][0].data).toEqual({
        expiresAt: null,
      });
      expect(prisma.stockItem.update.mock.calls[1][0].data).toEqual({
        expiresAt: new Date('2027-05-01'),
      });
    });

    it('güncellenecek alan yoksa BAD_REQUEST döner ve sorgu çalışmaz', async () => {
      expect(
        await rejectionMessage(service.updateStockItem(base, CLINIC)),
      ).toBe(ResponseMessages.BAD_REQUEST);
      expect(prisma.stockItem.update).not.toHaveBeenCalled();
    });

    it('kalem yoksa ya da başka kliniğe aitse NOT_FOUND, beklenmeyen hata olduğu gibi fırlatılır', async () => {
      prisma.stockItem.update.mockRejectedValueOnce(prismaError('P2025'));
      expect(
        await rejectionMessage(
          service.updateStockItem({ ...base, quantity: 1 }, CLINIC),
        ),
      ).toBe(ResponseMessages.NOT_FOUND);

      const unexpected = prismaError('P1001');
      prisma.stockItem.update.mockRejectedValueOnce(unexpected);
      await expect(
        service.updateStockItem({ ...base, quantity: 1 }, CLINIC),
      ).rejects.toBe(unexpected);
    });

    it('başka kliniğin yolu ve pasif klinik FORBIDDEN alır', async () => {
      expect(
        await rejectionMessage(
          service.updateStockItem({ ...base, quantity: 1 }, OTHER_CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);

      prisma.clinic.findUnique.mockResolvedValueOnce(
        clinicRow({ isActive: false }),
      );
      expect(
        await rejectionMessage(
          service.updateStockItem({ ...base, quantity: 1 }, CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.stockItem.update).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: artış ve azalışın tek atomik sorguda, sınırlar korunarak uygulandığını ve reddin nedenine göre doğru kodu verdiğini doğrulamak ---
  describe('adjustStockItem', () => {
    const base = { clinicId: CLINIC_ID, itemId: STOCK_ID };

    it('azalış, miktarın eksiye düşmemesi koşuluyla tek sorguda uygulanır', async () => {
      prisma.stockItem.findFirst.mockResolvedValue(stockRow({ quantity: 7 }));

      const { item } = await service.adjustStockItem(
        { ...base, delta: -3 },
        CLINIC,
      );

      expect(prisma.stockItem.updateMany).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID, quantity: { gte: 3 } },
        data: { quantity: { increment: -3 } },
      });
      expect(item?.quantity).toBe(7);
    });

    it('artış, 100.000 üst sınırını aşmaması koşuluyla uygulanır', async () => {
      await service.adjustStockItem({ ...base, delta: 20 }, CLINIC);

      expect(prisma.stockItem.updateMany).toHaveBeenCalledWith({
        where: {
          id: STOCK_ID,
          clinicId: CLINIC_ID,
          quantity: { lte: 99_980 },
        },
        data: { quantity: { increment: 20 } },
      });
    });

    it.each([
      ['sıfırın altına düşecek azalış', -50, 'QUANTITY_MIN|0'],
      ['100.000 sınırını aşacak artış', 99_999, 'QUANTITY_MAX|100000'],
    ])('%s reddedilir: %s → %s', async (_n, delta, message) => {
      prisma.stockItem.updateMany.mockResolvedValue({ count: 0 });

      expect(
        await rejectionMessage(
          service.adjustStockItem({ ...base, delta }, CLINIC),
        ),
      ).toBe(message);
      expect(prisma.stockItem.count).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID },
      });
      expect(prisma.stockItem.findFirst).not.toHaveBeenCalled();
    });

    it('kalem yoksa ya da başka kliniğe aitse NOT_FOUND', async () => {
      prisma.stockItem.updateMany.mockResolvedValue({ count: 0 });
      prisma.stockItem.count.mockResolvedValue(0);

      expect(
        await rejectionMessage(
          service.adjustStockItem({ ...base, delta: -1 }, CLINIC),
        ),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('başka kliniğin yolu FORBIDDEN alır', async () => {
      expect(
        await rejectionMessage(
          service.adjustStockItem({ ...base, delta: 1 }, OTHER_CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: stok kaleminin kalıcı silindiğini, silinen kalemin döndüğünü ve sahiplik kurallarını doğrulamak ---
  describe('deleteStockItem', () => {
    const base = { clinicId: CLINIC_ID, itemId: STOCK_ID };

    it('kalem kendi kliniğine sınırlı sorguyla kalıcı silinir ve silinen kalem döner', async () => {
      const { item } = await service.deleteStockItem(base, CLINIC);

      expect(prisma.stockItem.delete).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID },
      });
      expect(item).toMatchObject({ id: STOCK_ID, name: 'Amoksisilin' });
    });

    it('kalem yoksa ya da başka kliniğe aitse NOT_FOUND', async () => {
      prisma.stockItem.delete.mockRejectedValue(prismaError('P2025'));

      expect(
        await rejectionMessage(service.deleteStockItem(base, CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('başka kliniğin yolu FORBIDDEN alır', async () => {
      expect(
        await rejectionMessage(service.deleteStockItem(base, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.stockItem.delete).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: satışın atomik stok düşümüyle ve kalemin satış anındaki ad, birim ve fiyatlarının kopyasıyla yazıldığını, reddin nedenine göre doğru kodu verdiğini doğrulamak ---
  describe('createStockSale', () => {
    const request: clinics.CreateStockSaleRequest = {
      clinicId: CLINIC_ID,
      itemId: STOCK_ID,
      quantity: 3,
    };

    it('stoku yeterlilik koşuluyla düşer, satışı kalemin o anki ad, birim ve fiyatlarıyla yazar', async () => {
      const result = await service.createStockSale(request, CLINIC);

      expect(prisma.stockItem.findFirst).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID },
      });
      expect(prisma.stockItem.updateMany).toHaveBeenCalledWith({
        where: { id: STOCK_ID, clinicId: CLINIC_ID, quantity: { gte: 3 } },
        data: { quantity: { decrement: 3 } },
      });
      expect(prisma.stockSale.create).toHaveBeenCalledWith({
        data: {
          clinicId: CLINIC_ID,
          stockItemId: STOCK_ID,
          itemName: 'Amoksisilin',
          category: 'MEDICINE',
          unit: 'BOX',
          quantity: 3,
          unitSalePrice: 12_000,
          unitPurchasePrice: 8_000,
          createdBy: CLINIC_USER_ID,
        },
      });
      expect(result.sale).toMatchObject({
        id: SALE_ID,
        stockItemId: STOCK_ID,
        quantity: 3,
        unitSalePrice: 12_000,
        unitPurchasePrice: 8_000,
        totalSale: 36_000,
        totalCost: 24_000,
        profit: 12_000,
        cancelledAt: '',
      });
      expect(result.item?.quantity).toBe(7);
    });

    it.each([
      ['indirimli fiyat', 10_000],
      ['ücretsiz satış', 0],
    ])(
      '%s gönderilirse satış fiyatı olarak o yazılır',
      async (_n, unitPrice) => {
        await service.createStockSale({ ...request, unitPrice }, CLINIC);

        expect(prisma.stockSale.create.mock.calls[0][0].data).toMatchObject({
          unitSalePrice: unitPrice,
          unitPurchasePrice: 8_000,
        });
      },
    );

    it('alış fiyatının altındaki satışta kâr eksi döner', async () => {
      prisma.stockSale.create.mockResolvedValue(
        saleRow({ unitSalePrice: 5_000 }),
      );

      const { sale } = await service.createStockSale(
        { ...request, unitPrice: 5_000 },
        CLINIC,
      );

      expect(sale).toMatchObject({
        totalSale: 15_000,
        totalCost: 24_000,
        profit: -9_000,
      });
    });

    it('stok yetersizse QUANTITY_MIN|0 döner ve satış yazılmaz', async () => {
      prisma.stockItem.updateMany.mockResolvedValue({ count: 0 });

      expect(
        await rejectionMessage(service.createStockSale(request, CLINIC)),
      ).toBe('QUANTITY_MIN|0');
      expect(prisma.stockSale.create).not.toHaveBeenCalled();
    });

    it.each([
      ['alış fiyatı', { purchasePrice: null }, 'PURCHASE_PRICE_NOT_EMPTY'],
      ['satış fiyatı', { salePrice: null }, 'SALE_PRICE_NOT_EMPTY'],
      [
        'iki fiyatı da',
        { purchasePrice: null, salePrice: null },
        'PURCHASE_PRICE_NOT_EMPTY',
      ],
    ])(
      '%s tanımsız kalem satılamaz, stoka dokunulmaz',
      async (_n, prices, message) => {
        prisma.stockItem.findFirst.mockResolvedValue(stockRow(prices));

        expect(
          await rejectionMessage(service.createStockSale(request, CLINIC)),
        ).toBe(message);
        expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
        expect(prisma.stockSale.create).not.toHaveBeenCalled();
      },
    );

    it('kalem yoksa ya da başka kliniğe aitse NOT_FOUND', async () => {
      prisma.stockItem.findFirst.mockResolvedValue(null);

      expect(
        await rejectionMessage(service.createStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
      expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
    });

    it('başka kliniğin yolu ve pasif klinik FORBIDDEN alır, işlem başlamaz', async () => {
      expect(
        await rejectionMessage(service.createStockSale(request, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);

      prisma.clinic.findUnique.mockResolvedValueOnce(
        clinicRow({ isActive: false }),
      );
      expect(
        await rejectionMessage(service.createStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: iptalin yalnızca satışın yapıldığı İstanbul ayında ve tek kez yapılabildiğini, stoku aynı işlemde geri eklediğini doğrulamak ---
  describe('cancelStockSale', () => {
    const request = { clinicId: CLINIC_ID, saleId: SALE_ID };
    const NOW = new Date('2026-10-17T09:00:00.000Z');
    const SOLD_AT = new Date('2026-10-10T10:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
      prisma.stockSale.findFirst.mockResolvedValue(
        saleRow({ soldAt: SOLD_AT }),
      );
    });

    afterEach(() => jest.useRealTimers());

    it('satışı iptal eder ve satılan miktarı üst sınır korunarak stoka geri ekler', async () => {
      prisma.stockSale.findUniqueOrThrow.mockResolvedValue(
        saleRow({ soldAt: SOLD_AT, cancelledAt: NOW }),
      );

      const result = await service.cancelStockSale(request, CLINIC);

      expect(prisma.stockSale.findFirst).toHaveBeenCalledWith({
        where: { id: SALE_ID, clinicId: CLINIC_ID },
      });
      expect(prisma.stockSale.updateMany).toHaveBeenCalledWith({
        where: { id: SALE_ID, cancelledAt: null },
        data: { cancelledAt: NOW },
      });
      expect(prisma.stockItem.updateMany).toHaveBeenCalledWith({
        where: { id: STOCK_ID, quantity: { lte: 99_997 } },
        data: { quantity: { increment: 3 } },
      });
      expect(result.sale?.cancelledAt).toBe(NOW.toISOString());
      expect(result.item?.quantity).toBe(13);
    });

    it('İstanbul ayının ilk dakikasında yapılan satış ay içinde iptal edilebilir', async () => {
      prisma.stockSale.findFirst.mockResolvedValue(
        saleRow({ soldAt: new Date('2026-09-30T21:00:00.000Z') }),
      );

      await service.cancelStockSale(request, CLINIC);

      expect(prisma.stockSale.updateMany).toHaveBeenCalled();
    });

    it('önceki İstanbul ayında yapılan satış CONFLICT alır, stoka dokunulmaz', async () => {
      prisma.stockSale.findFirst.mockResolvedValue(
        saleRow({ soldAt: new Date('2026-09-30T20:59:59.000Z') }),
      );

      expect(
        await rejectionMessage(service.cancelStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.CONFLICT);
      expect(prisma.stockSale.updateMany).not.toHaveBeenCalled();
      expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
    });

    it('zaten iptal edilmiş satış CONFLICT alır', async () => {
      prisma.stockSale.findFirst.mockResolvedValue(
        saleRow({ soldAt: SOLD_AT, cancelledAt: SOLD_AT }),
      );

      expect(
        await rejectionMessage(service.cancelStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.CONFLICT);
      expect(prisma.stockSale.updateMany).not.toHaveBeenCalled();
    });

    it('eşzamanlı ikinci iptal CONFLICT alır ve stok iki kez geri eklenmez', async () => {
      prisma.stockSale.updateMany.mockResolvedValue({ count: 0 });

      expect(
        await rejectionMessage(service.cancelStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.CONFLICT);
      expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
    });

    it('kalemi silinmiş satış stoka dokunmadan iptal edilir', async () => {
      prisma.stockSale.findFirst.mockResolvedValue(
        saleRow({ soldAt: SOLD_AT, stockItemId: null }),
      );
      prisma.stockSale.findUniqueOrThrow.mockResolvedValue(
        saleRow({ soldAt: SOLD_AT, stockItemId: null, cancelledAt: NOW }),
      );

      const result = await service.cancelStockSale(request, CLINIC);

      expect(prisma.stockItem.updateMany).not.toHaveBeenCalled();
      expect(result.item).toBeUndefined();
      expect(result.sale?.stockItemId).toBe('');
    });

    it('kalem iptal sırasında silinirse satış yine iptal edilir', async () => {
      prisma.stockItem.updateMany.mockResolvedValue({ count: 0 });
      prisma.stockItem.findUnique.mockResolvedValue(null);

      const result = await service.cancelStockSale(request, CLINIC);

      expect(result.item).toBeUndefined();
      expect(prisma.stockSale.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: SALE_ID },
      });
    });

    it('geri ekleme 100.000 sınırını aşacaksa QUANTITY_MAX|100000 döner', async () => {
      prisma.stockItem.updateMany.mockResolvedValue({ count: 0 });
      prisma.stockItem.findUnique.mockResolvedValue(
        stockRow({ quantity: 99_999 }),
      );

      expect(
        await rejectionMessage(service.cancelStockSale(request, CLINIC)),
      ).toBe('QUANTITY_MAX|100000');
      expect(prisma.stockSale.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('satış yoksa ya da başka kliniğe aitse NOT_FOUND', async () => {
      prisma.stockSale.findFirst.mockResolvedValue(null);

      expect(
        await rejectionMessage(service.cancelStockSale(request, CLINIC)),
      ).toBe(ResponseMessages.NOT_FOUND);
    });

    it('başka kliniğin yolu FORBIDDEN alır, işlem başlamaz', async () => {
      expect(
        await rejectionMessage(service.cancelStockSale(request, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: satış listesinin İstanbul gün sınırlarıyla filtrelendiğini, iptaller dahil yeniden eskiye sıralanıp sayfalandığını doğrulamak ---
  describe('listStockSales', () => {
    const base: clinics.ListStockSalesRequest = {
      clinicId: CLINIC_ID,
      fromDate: '',
      toDate: '',
      page: 1,
      pageSize: 8,
    };

    it('filtresiz istekte yalnızca klinik koşulu, yeniden eskiye sıralama ve sayfa ofseti kullanılır', async () => {
      prisma.stockSale.findMany.mockResolvedValue([
        saleRow({
          soldAt: new Date('2026-10-12T08:00:00.000Z'),
          cancelledAt: new Date('2026-10-12T09:00:00.000Z'),
        }),
      ]);

      const result = await service.listStockSales({ ...base, page: 2 }, CLINIC);

      expect(prisma.stockSale.findMany).toHaveBeenCalledWith({
        where: { clinicId: CLINIC_ID },
        orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
        skip: 8,
        take: 8,
      });
      expect(prisma.stockSale.count).toHaveBeenCalledWith({
        where: { clinicId: CLINIC_ID },
      });
      expect(result).toMatchObject({ total: 1, page: 2, pageSize: 8 });
      expect(result.sales).toEqual([
        {
          id: SALE_ID,
          clinicId: CLINIC_ID,
          stockItemId: STOCK_ID,
          itemName: 'Amoksisilin',
          category: 'MEDICINE',
          unit: 'BOX',
          quantity: 3,
          unitSalePrice: 12_000,
          unitPurchasePrice: 8_000,
          totalSale: 36_000,
          totalCost: 24_000,
          profit: 12_000,
          soldAt: '2026-10-12T08:00:00.000Z',
          cancelledAt: '2026-10-12T09:00:00.000Z',
        },
      ]);
    });

    it.each([
      [
        'iki tarih',
        { fromDate: '2026-10-01', toDate: '2026-10-16' },
        {
          gte: new Date('2026-09-30T21:00:00.000Z'),
          lt: new Date('2026-10-16T21:00:00.000Z'),
        },
      ],
      [
        'yalnızca başlangıç',
        { fromDate: '2026-10-01' },
        { gte: new Date('2026-09-30T21:00:00.000Z') },
      ],
      [
        'yalnızca bitiş',
        { toDate: '2026-10-31' },
        { lt: new Date('2026-10-31T21:00:00.000Z') },
      ],
    ])('%s İstanbul gün sınırlarına çevrilir', async (_n, dates, soldAt) => {
      await service.listStockSales({ ...base, ...dates }, CLINIC);

      expect(prisma.stockSale.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC_ID,
        soldAt,
      });
      expect(prisma.stockSale.count).toHaveBeenCalledWith({
        where: { clinicId: CLINIC_ID, soldAt },
      });
    });

    it('başka kliniğin yolu FORBIDDEN alır', async () => {
      expect(
        await rejectionMessage(service.listStockSales(base, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.stockSale.findMany).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: aylık raporun iptalleri dışlayan İstanbul ayı sorgularını kurduğunu, günleri ve haftaları sıfırla doldurduğunu, toplamları ve ürün kırılımını doğru hesapladığını doğrulamak ---
  describe('getStockSalesSummary', () => {
    const request = { clinicId: CLINIC_ID, month: '2026-10' };
    const zero = { revenue: 0, cost: 0, profit: 0, salesCount: 0, quantity: 0 };
    const aggregate = (
      revenue: number,
      cost: number,
      salesCount: number,
      quantity: number,
    ) => ({
      revenue: BigInt(revenue),
      cost: BigInt(cost),
      salesCount,
      quantity: BigInt(quantity),
    });

    afterEach(() => jest.useRealTimers());

    it('İstanbul ayının UTC sınırlarıyla ve iptaller hariç iki sorgu çalıştırır', async () => {
      await service.getStockSalesSummary(request, CLINIC);

      const [daily, products] = prisma.$queryRaw.mock.calls;
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(daily.slice(1)).toEqual([
        'Europe/Istanbul',
        CLINIC_ID,
        '2026-09-30T21:00:00.000Z',
        '2026-10-31T21:00:00.000Z',
      ]);
      expect(products.slice(1)).toEqual([
        CLINIC_ID,
        '2026-09-30T21:00:00.000Z',
        '2026-10-31T21:00:00.000Z',
      ]);
      expect(daily[0].join('')).toContain('s.cancelled_at IS NULL');
      expect(products[0].join('')).toContain('s.cancelled_at IS NULL');
    });

    it('satış olmayan ay 31 gün ve aya kırpılmış 5 hafta boyunca sıfırla doldurulur', async () => {
      const result = await service.getStockSalesSummary(request, CLINIC);

      expect(result.month).toBe('2026-10');
      expect(result.totals).toEqual(zero);
      expect(result.daily).toHaveLength(31);
      expect(result.daily[0]).toEqual({ date: '2026-10-01', ...zero });
      expect(result.daily[30]).toEqual({ date: '2026-10-31', ...zero });
      expect(result.weekly).toEqual([
        { weekStart: '2026-10-01', weekEnd: '2026-10-04', ...zero },
        { weekStart: '2026-10-05', weekEnd: '2026-10-11', ...zero },
        { weekStart: '2026-10-12', weekEnd: '2026-10-18', ...zero },
        { weekStart: '2026-10-19', weekEnd: '2026-10-25', ...zero },
        { weekStart: '2026-10-26', weekEnd: '2026-10-31', ...zero },
      ]);
      expect(result.products).toEqual([]);
    });

    it('günlük satırlar sayıya çevrilir, haftalar ve toplamlar günlerden hesaplanır', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { day: '2026-10-03', ...aggregate(36_000, 24_000, 1, 3) },
          { day: '2026-10-05', ...aggregate(24_000, 16_000, 2, 2) },
          { day: '2026-10-11', ...aggregate(10_000, 12_000, 1, 1) },
          {
            day: '2026-10-31',
            ...aggregate(5_000_000_000, 1_000_000_000, 1, 5),
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getStockSalesSummary(request, CLINIC);

      expect(result.daily[2]).toEqual({
        date: '2026-10-03',
        revenue: 36_000,
        cost: 24_000,
        profit: 12_000,
        salesCount: 1,
        quantity: 3,
      });
      expect(result.daily[3]).toEqual({ date: '2026-10-04', ...zero });
      expect(result.weekly[1]).toEqual({
        weekStart: '2026-10-05',
        weekEnd: '2026-10-11',
        revenue: 34_000,
        cost: 28_000,
        profit: 6_000,
        salesCount: 3,
        quantity: 3,
      });
      expect(result.weekly.map((week) => week.profit)).toEqual([
        12_000, 6_000, 0, 0, 4_000_000_000,
      ]);
      expect(result.totals).toEqual({
        revenue: 5_000_070_000,
        cost: 1_000_052_000,
        profit: 4_000_018_000,
        salesCount: 5,
        quantity: 11,
      });
    });

    it('ürün kırılımında değerler sayıya çevrilir, silinmiş kalem boş kimlikle döner', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          stockItemId: STOCK_ID,
          itemName: 'Amoksisilin',
          unit: 'BOX',
          ...aggregate(60_000, 40_000, 2, 5),
        },
        {
          stockItemId: null,
          itemName: 'Kuduz Aşısı',
          unit: 'DOSE',
          ...aggregate(30_000, 18_000, 1, 2),
        },
      ]);

      const { products } = await service.getStockSalesSummary(request, CLINIC);

      expect(products).toEqual([
        {
          stockItemId: STOCK_ID,
          itemName: 'Amoksisilin',
          unit: 'BOX',
          revenue: 60_000,
          cost: 40_000,
          profit: 20_000,
          salesCount: 2,
          quantity: 5,
        },
        {
          stockItemId: '',
          itemName: 'Kuduz Aşısı',
          unit: 'DOSE',
          revenue: 30_000,
          cost: 18_000,
          profit: 12_000,
          salesCount: 1,
          quantity: 2,
        },
      ]);
    });

    it('ay gönderilmezse İstanbul’da içinde bulunulan ay kullanılır', async () => {
      jest.useFakeTimers({
        now: new Date('2026-10-31T21:30:00.000Z'),
        doNotFake: ['nextTick', 'setImmediate'],
      });

      const result = await service.getStockSalesSummary(
        { clinicId: CLINIC_ID, month: '' },
        CLINIC,
      );

      expect(result.month).toBe('2026-11');
      expect(result.daily).toHaveLength(30);
      expect(prisma.$queryRaw.mock.calls[0].slice(-2)).toEqual([
        '2026-10-31T21:00:00.000Z',
        '2026-11-30T21:00:00.000Z',
      ]);
    });

    it('başka kliniğin yolu FORBIDDEN alır ve sorgu çalışmaz', async () => {
      expect(
        await rejectionMessage(
          service.getStockSalesSummary(request, OTHER_CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: hayvan özetinin zorunlu pet kaynağını ve isteğe bağlı kaynakların kısmi başarı kurallarını doğrulamak ---
  describe('getClinicPetOverview', () => {
    const request = { clinicId: CLINIC_ID, petId: PET_ID };

    it('tüm kaynaklar başarılıysa özet, sahip, son kayıtlar ve bekleyen taslak sayısı döner', async () => {
      const result = await service.getClinicPetOverview(request, CLINIC);

      expect(usersClient.getUserContact).toHaveBeenCalledWith({
        userId: OWNER_ID,
        petId: PET_ID,
      });
      expect(medicalRecordClient.listRecordsByPet).toHaveBeenCalledWith({
        petId: PET_ID,
        fromDate: '',
        toDate: '',
        page: 1,
        pageSize: RECENT_RECORD_LIMIT,
      });
      expect(medicalRecordClient.listDraftReviews).toHaveBeenCalledWith({
        petId: PET_ID,
        status: medicalRecord.DraftReviewStatus.PENDING,
        page: 1,
        pageSize: RECENT_RECORD_LIMIT,
      });
      expect(result).toEqual({
        pet: {
          petId: PET_ID,
          name: 'Boncuk',
          species: 'DOG',
          breed: 'KANGAL',
          birthDate: '2022-05-10',
          chipNumberMasked: '****3444',
          ownerUserId: OWNER_ID,
        },
        owner: {
          userId: OWNER_ID,
          fullName: 'Ayşe Yılmaz',
          phone: '+905551234567',
        },
        recentRecords: [
          {
            recordId: 'kayit-1',
            type: 'VACCINATION',
            title: 'Kuduz aşısı',
            recordedAt: '2026-02-01T10:00:00.000Z',
          },
        ],
        pendingDraftReviewCount: 3,
        unavailableSources: [],
      });
    });

    it('başka kliniğin adına istek FORBIDDEN alır ve hiçbir servise gitmez', async () => {
      expect(
        await rejectionMessage(
          service.getClinicPetOverview(request, OTHER_CLINIC),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(petsClient.getPet).not.toHaveBeenCalled();
    });

    it.each([
      [
        'pets NOT_FOUND',
        grpcError(status.NOT_FOUND, ResponseMessages.NOT_FOUND),
        ResponseMessages.NOT_FOUND,
      ],
      [
        'pets ulaşılamıyor',
        grpcError(status.UNAVAILABLE),
        ResponseMessages.SERVICE_UNAVAILABLE,
      ],
    ])('%s ise özet dönmez: %s', async (_n, error, expected) => {
      petsClient.getPet.mockReturnValue(throwError(() => error));
      expect(
        await rejectionMessage(service.getClinicPetOverview(request, CLINIC)),
      ).toBe(expected);
      expect(usersClient.getUserContact).not.toHaveBeenCalled();
    });

    it('pets boş yanıt dönerse INTERNAL_SERVER_ERROR', async () => {
      petsClient.getPet.mockReturnValue(of({}));
      expect(
        await rejectionMessage(service.getClinicPetOverview(request, CLINIC)),
      ).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });

    it.each([
      ['PERMISSION_DENIED', status.PERMISSION_DENIED],
      ['NOT_FOUND', status.NOT_FOUND],
    ])(
      'users %s dönerse sahip bloğu boş kalır ama kaynak kullanılamıyor sayılmaz',
      async (_n, code) => {
        usersClient.getUserContact.mockReturnValue(
          throwError(() => grpcError(code)),
        );

        const result = await service.getClinicPetOverview(request, CLINIC);
        expect(result.owner).toBeUndefined();
        expect(result.unavailableSources).toEqual([]);
      },
    );

    it('users ve medical_record ulaşılamazsa kaynaklar tekilleştirilerek bildirilir', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      usersClient.getUserContact.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );
      medicalRecordClient.listRecordsByPet.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );
      medicalRecordClient.listDraftReviews.mockReturnValue(
        throwError(() => grpcError(status.UNIMPLEMENTED)),
      );

      const result = await service.getClinicPetOverview(request, CLINIC);

      expect(result.owner).toBeUndefined();
      expect(result.recentRecords).toEqual([]);
      expect(result.pendingDraftReviewCount).toBe(0);
      expect(result.unavailableSources).toEqual(['users', 'medical_record']);
    });
  });

  // ---Amaç: sonuç yüklemenin klinik kontrolünden sonra belge referansını medical_record'a ilettiğini ve hataları doğru aktardığını doğrulamak ---
  describe('uploadPetResult', () => {
    const request: clinics.UploadPetResultRequest = {
      clinicId: CLINIC_ID,
      petId: PET_ID,
      storagePath: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c.pdf',
      sha256: 'a'.repeat(64),
      originalName: 'Kan Tahlili.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      note: 'Açlık kan şekeri',
    };

    it('belge referansını clinicId olmadan iletir ve yanıtı eşler', async () => {
      await expect(service.uploadPetResult(request, CLINIC)).resolves.toEqual({
        documentId: 'belge-1',
        uploadedAt: '2026-10-13T10:00:00.000Z',
        status: 'QUEUED',
      });
      expect(medicalRecordClient.registerDocument).toHaveBeenCalledWith({
        petId: PET_ID,
        storagePath: request.storagePath,
        originalName: request.originalName,
        mimeType: request.mimeType,
        sizeBytes: request.sizeBytes,
        sha256: request.sha256,
        note: request.note,
      });
    });

    it('not gelmezse boş string iletilir', async () => {
      await service.uploadPetResult(
        { ...request, note: undefined as unknown as string },
        CLINIC,
      );
      expect(medicalRecordClient.registerDocument).toHaveBeenCalledWith(
        expect.objectContaining({ note: '' }),
      );
    });

    it('başka kliniğin adına FORBIDDEN, medical_record çağrılmaz', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(
        await rejectionMessage(service.uploadPetResult(request, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
      expect(medicalRecordClient.registerDocument).not.toHaveBeenCalled();
    });

    it.each([
      ['pasif', clinicRow({ isActive: false }), ResponseMessages.FORBIDDEN],
      ['kayıtsız', null, ResponseMessages.NOT_FOUND],
    ])(
      '%s klinik reddedilir, medical_record çağrılmaz',
      async (_n, row, expected) => {
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        prisma.clinic.findUnique.mockResolvedValueOnce(row);
        expect(
          await rejectionMessage(service.uploadPetResult(request, CLINIC)),
        ).toBe(expected);
        expect(medicalRecordClient.registerDocument).not.toHaveBeenCalled();
      },
    );

    it.each([
      [ResponseMessages.FORBIDDEN, status.PERMISSION_DENIED],
      [ResponseMessages.CONFLICT, status.ALREADY_EXISTS],
    ])(
      'medical_record %s döndürürse aynen aktarılır',
      async (details, code) => {
        medicalRecordClient.registerDocument.mockReturnValue(
          throwError(() => grpcError(code, details)),
        );
        expect(
          await rejectionMessage(service.uploadPetResult(request, CLINIC)),
        ).toBe(details);
      },
    );

    it("medical_record'a ulaşılamazsa SERVICE_UNAVAILABLE", async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      medicalRecordClient.registerDocument.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );
      expect(
        await rejectionMessage(service.uploadPetResult(request, CLINIC)),
      ).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    });

    it('zaman aşımında belge oluşmuş olabileceği loglanır', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      medicalRecordClient.registerDocument.mockReturnValue(
        throwError(() => grpcError(status.DEADLINE_EXCEEDED)),
      );
      expect(
        await rejectionMessage(service.uploadPetResult(request, CLINIC)),
      ).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('belge kaydı oluşmuş olabilir'),
      );
    });

    it('beklenmeyen hata ve boş yanıt INTERNAL_SERVER_ERROR', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      medicalRecordClient.registerDocument.mockReturnValueOnce(
        throwError(() =>
          grpcError(status.INVALID_ARGUMENT, 'SHA256_WRONG DATA FORMAT'),
        ),
      );
      expect(
        await rejectionMessage(service.uploadPetResult(request, CLINIC)),
      ).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
      medicalRecordClient.registerDocument.mockReturnValueOnce(of({}));
      expect(
        await rejectionMessage(service.uploadPetResult(request, CLINIC)),
      ).toBe(ResponseMessages.INTERNAL_SERVER_ERROR);
    });
  });
});
