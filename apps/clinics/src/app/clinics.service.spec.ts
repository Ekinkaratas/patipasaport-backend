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
  createdBy: CLINIC_USER_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
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
      count: jest.Mock;
      fields: { criticalLevel: string };
    };
    $transaction: jest.Mock;
  };
  let petsClient: { getPet: jest.Mock };
  let usersClient: { getUserContact: jest.Mock; deactivateClinicUsers: jest.Mock };
  let medicalRecordClient: {
    listRecordsByPet: jest.Mock;
    listDraftReviews: jest.Mock;
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
        count: jest.fn().mockResolvedValue(1),
        fields: { criticalLevel: 'criticalLevel-alan-referansi' },
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
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
    };

    it('kalemi JWT kullanıcısıyla yazar ve proto biçiminde döner', async () => {
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
      });
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

  // ---Amaç: sonuç yüklemenin tasarım beklerken sahiplik kontrolünden sonra UNIMPLEMENTED döndüğünü doğrulamak ---
  describe('uploadPetResult', () => {
    const request: clinics.UploadPetResultRequest = {
      clinicId: CLINIC_ID,
      petId: PET_ID,
      storagePath: 'dosya.pdf',
      sha256: 'a'.repeat(64),
      originalName: 'Kan Tahlili.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      note: '',
    };

    it('başka kliniğin adına FORBIDDEN', async () => {
      expect(
        await rejectionMessage(service.uploadPetResult(request, OTHER_CLINIC)),
      ).toBe(ResponseMessages.FORBIDDEN);
    });

    it('kendi kliniğinde METHOD_NOT_ALLOWED (UNIMPLEMENTED)', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(
        await rejectionMessage(service.uploadPetResult(request, CLINIC)),
      ).toBe(ResponseMessages.METHOD_NOT_ALLOWED);
    });
  });
});
