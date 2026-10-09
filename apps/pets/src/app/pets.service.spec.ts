jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { access, pets } from '@libs/proto';
import {
  AuthUser,
  DtoPrefix,
  getValidationMessage,
  ResponseMessages,
  ValidationType,
} from '@libs/common';
import { PetsService } from './pets.service';
import { PrismaService } from './prisma/prisma.service';
import { ChipCryptoService } from './crypto/chip-crypto.service';
import {
  Pet,
  PetSex as DbPetSex,
  PetSpecies,
  Prisma,
} from '../generated/prisma/client';

const OWNER_ID = '8f9e0d1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f';
const OTHER_OWNER_ID = '4d5e6f70-8192-4a3b-9c4d-5e6f708192a3';
const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const OTHER_PET_ID = '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c';
const CONSENT_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const CHIP = '900111222333444';
const NEW_CHIP = '900555666777888';

const OWNER: AuthUser = {
  userId: OWNER_ID,
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
};

const OTHER_OWNER: AuthUser = { ...OWNER, userId: OTHER_OWNER_ID };

const CLINIC: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: CLINIC_ID,
  clientType: access.ClientType.WEB,
};

// ---Amaç: veritabanından dönen pet satırını üretmek ---
const petRow = (over: Partial<Pet> = {}): Pet => ({
  id: PET_ID,
  name: 'Boncuk',
  species: PetSpecies.DOG,
  breed: 'KANGAL',
  sex: DbPetSex.MALE,
  birthDate: new Date('2022-05-10T00:00:00.000Z'),
  isBirthDateEstimated: false,
  isNeutered: true,
  ownerUserId: OWNER_ID,
  chipNoEncrypted: `sifreli:${CHIP}`,
  chipNoIndex: `indeks:${CHIP}`,
  chipNoLast4: '3444',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

// ---Amaç: Prisma'nın create/update ile yazdığı satırı undefined alanları değiştirmeden taklit etmek ---
const writtenRow = ({ data }: { data: Partial<Pet> }) =>
  Promise.resolve(
    petRow(
      Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      ) as Partial<Pet>,
    ),
  );

// ---Amaç: access.CheckAccess yanıtını üretmek ---
const checkAccessResponse = (
  over: Partial<access.CheckAccessResponse> = {},
): access.CheckAccessResponse => ({
  allowed: true,
  grantedScopes: ['chip_number_read'],
  missingScopes: [],
  consentId: CONSENT_ID,
  status: access.ConsentStatus.ACTIVE,
  expiresAt: '2026-12-01T00:00:00.000Z',
  deniedReason: access.DeniedReason.DENIED_REASON_UNSPECIFIED,
  petOwnerId: OWNER_ID,
  ...over,
});

// ---Amaç: access.ListMyConsents sayfasını üretmek ---
const consentPage = (
  petIds: string[],
  total = petIds.length,
): access.ListMyConsentsResponse => ({
  consents: petIds.map((petId) => ({
    consentId: CONSENT_ID,
    status: access.ConsentStatus.ACTIVE,
    ownerUserId: '',
    clinicId: CLINIC_ID,
    petId,
    scopes: ['medical_read'],
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    revokedAt: '',
  })),
  total,
  page: 1,
  pageSize: 128,
});

// ---Amaç: Prisma'nın bilinen hata kodlarını adapter kısıt bilgisiyle taklit etmek ---
const prismaError = (code: string, index?: string) =>
  new Prisma.PrismaClientKnownRequestError('test hatasi', {
    code,
    clientVersion: 'test',
    meta: index
      ? { driverAdapterError: { cause: { constraint: { index } } } }
      : undefined,
  });

// ---Amaç: access servisinden dönen gRPC hatasını taklit etmek ---
const grpcError = (code: number, details?: string) =>
  Object.assign(new Error(details ?? 'grpc hatasi'), { code, details });

// ---Amaç: ClientGrpc.getService'in döndüreceği istemciyi bağlamak ---
const clientGrpcFor = (implementation: unknown): ClientGrpc =>
  ({ getService: () => implementation }) as unknown as ClientGrpc;

// ---Amaç: CreatePet isteğini üretmek ---
const createRequest = (
  over: Partial<pets.CreatePetRequest> = {},
): pets.CreatePetRequest => ({
  name: 'Boncuk',
  species: 'DOG',
  breed: 'KANGAL',
  sex: pets.PetSex.MALE,
  birthDate: '2022-05-10',
  isBirthDateEstimated: false,
  isNeutered: true,
  chipNumber: CHIP,
  ownerUserId: OWNER_ID,
  ...over,
});

describe('PetsService', () => {
  let service: PetsService;
  let prisma: {
    pet: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let accessClient: { checkAccess: jest.Mock; listMyConsents: jest.Mock };
  let chipCrypto: {
    encrypt: jest.Mock;
    blindIndex: jest.Mock;
    decryptChip: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      pet: {
        findUnique: jest.fn().mockResolvedValue(petRow()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(writtenRow),
        update: jest.fn().mockImplementation(writtenRow),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    accessClient = {
      checkAccess: jest.fn().mockReturnValue(of(checkAccessResponse())),
      listMyConsents: jest.fn().mockReturnValue(of(consentPage([]))),
    };
    chipCrypto = {
      encrypt: jest.fn((chip: string) => `sifreli:${chip}`),
      blindIndex: jest.fn((chip: string) => `indeks:${chip}`),
      decryptChip: jest.fn((stored: string) => stored.replace(/^sifreli:/, '')),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PetsService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'ACCESS_SERVICE', useValue: clientGrpcFor(accessClient) },
        { provide: ChipCryptoService, useValue: chipCrypto },
      ],
    }).compile();

    service = moduleRef.get(PetsService);
    await service.onModuleInit();
  });

  // ---Amaç: petin role ve rızaya göre tam ya da maskeli çiple döndüğünü doğrulamak ---
  describe('getPet', () => {
    it('pet yoksa NOT_FOUND atar ve access-e gitmez', async () => {
      prisma.pet.findUnique.mockResolvedValue(null);

      const error = await service
        .getPet({ id: PET_ID }, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
      expect(prisma.pet.findUnique).toHaveBeenCalledWith({
        where: { id: PET_ID },
      });
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('sahip kendi petini tum alanlar ve tam cip ile gorur', async () => {
      const { pet } = await service.getPet({ id: PET_ID }, OWNER);

      expect(pet).toEqual({
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
        chipNumber: CHIP,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('baska sahip NOT_FOUND alir ve cip cozulmez', async () => {
      const error = await service
        .getPet({ id: PET_ID }, OTHER_OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
      expect(chipCrypto.decryptChip).not.toHaveBeenCalled();
    });

    it('chip_number_read izni olan klinik tam cipi gorur', async () => {
      const { pet } = await service.getPet({ id: PET_ID }, CLINIC);

      expect(accessClient.checkAccess).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        requiredScopes: ['chip_number_read'],
      });
      expect(pet?.chipNumber).toBe(CHIP);
    });

    it('rizasi olup cip izni olmayan klinik yalnizca maskeyi gorur', async () => {
      accessClient.checkAccess.mockReturnValue(
        of(
          checkAccessResponse({
            allowed: false,
            grantedScopes: [],
            missingScopes: ['chip_number_read'],
            deniedReason: access.DeniedReason.DENIED_REASON_INSUFFICIENT_SCOPE,
          }),
        ),
      );

      const { pet } = await service.getPet({ id: PET_ID }, CLINIC);

      expect(pet?.chipNumber).toBe('');
      expect(pet?.chipNumberMasked).toBe('****3444');
      expect(chipCrypto.decryptChip).not.toHaveBeenCalled();
    });

    it.each([
      ['riza yok', access.ConsentStatus.NOT_FOUND],
      ['riza iptal edilmis', access.ConsentStatus.REVOKED],
      ['riza suresi dolmus', access.ConsentStatus.EXPIRED],
    ])('%s ise klinik NOT_FOUND alir', async (_n, consentStatus) => {
      accessClient.checkAccess.mockReturnValue(
        of(checkAccessResponse({ allowed: false, status: consentStatus })),
      );

      const error = await service
        .getPet({ id: PET_ID }, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
    });

    it.each([
      ['UNAVAILABLE', ResponseMessages.SERVICE_UNAVAILABLE, status.UNAVAILABLE],
      [
        'DEADLINE_EXCEEDED',
        ResponseMessages.SERVICE_UNAVAILABLE,
        status.DEADLINE_EXCEEDED,
      ],
      [
        'INVALID_ARGUMENT',
        ResponseMessages.INTERNAL_SERVER_ERROR,
        status.INVALID_ARGUMENT,
      ],
    ])('access %s donerse %s atar', async (_n, expected, code) => {
      accessClient.checkAccess.mockReturnValue(
        throwError(() => grpcError(code)),
      );

      const error = await service
        .getPet({ id: PET_ID }, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(expected);
    });

    it('cipsiz ve dogum tarihsiz pette ilgili alanlar bos doner', async () => {
      prisma.pet.findUnique.mockResolvedValue(
        petRow({
          sex: DbPetSex.FEMALE,
          birthDate: null,
          chipNoEncrypted: null,
          chipNoIndex: null,
          chipNoLast4: null,
        }),
      );

      const { pet } = await service.getPet({ id: PET_ID }, OWNER);

      expect(pet).toEqual(
        expect.objectContaining({
          sex: pets.PetSex.FEMALE,
          birthDate: '',
          chipNumberMasked: '',
          chipNumber: '',
        }),
      );
      expect(chipCrypto.decryptChip).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: klinik aramasının yalnızca rızalı petlerde, istenen filtre, sıra ve sayfayla yapıldığını doğrulamak ---
  describe('searchClinicPets', () => {
    const baseRequest: pets.SearchClinicPetsRequest = { page: 1, pageSize: 8 };

    beforeEach(() => {
      accessClient.listMyConsents.mockReturnValue(
        of(consentPage([PET_ID, OTHER_PET_ID])),
      );
      prisma.pet.findMany.mockResolvedValue([
        petRow(),
        petRow({ id: OTHER_PET_ID, name: 'Işık' }),
      ]);
      prisma.pet.count.mockResolvedValue(2);
    });

    it('rizali pet id-leriyle filtreler, varsayilan olarak en yeniden eskiye siralar', async () => {
      const response = await service.searchClinicPets(baseRequest);
      const where = { id: { in: [PET_ID, OTHER_PET_ID] } };

      expect(accessClient.listMyConsents).toHaveBeenCalledWith({
        page: 1,
        pageSize: 128,
      });
      expect(prisma.pet.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: 0,
        take: 8,
      });
      expect(prisma.pet.count).toHaveBeenCalledWith({ where });
      expect(response).toEqual(
        expect.objectContaining({ total: 2, page: 1, pageSize: 8 }),
      );
      expect(response.pets.map((pet) => pet.id)).toEqual([
        PET_ID,
        OTHER_PET_ID,
      ]);
    });

    it('liste ve toplam tek transaction icinde okunur', async () => {
      await service.searchClinicPets(baseRequest);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    });

    it('ozet kartta sahip id-si ve tam cip yoktur', async () => {
      const { pets: summaries } = await service.searchClinicPets(baseRequest);

      expect(summaries[0]).toEqual({
        id: PET_ID,
        name: 'Boncuk',
        species: 'DOG',
        breed: 'KANGAL',
        sex: pets.PetSex.MALE,
        birthDate: '2022-05-10',
        isBirthDateEstimated: false,
        chipNumberMasked: '****3444',
      });
      expect(chipCrypto.decryptChip).not.toHaveBeenCalled();
    });

    it('birden fazla riza sayfasini toplar', async () => {
      const firstPage = Array.from({ length: 128 }, (_, i) => `pet-${i}`);
      accessClient.listMyConsents
        .mockReturnValueOnce(of(consentPage(firstPage, 130)))
        .mockReturnValueOnce(of(consentPage(['pet-128', 'pet-129'], 130)));

      await service.searchClinicPets(baseRequest);

      expect(accessClient.listMyConsents).toHaveBeenCalledTimes(2);
      expect(accessClient.listMyConsents).toHaveBeenNthCalledWith(1, {
        page: 1,
        pageSize: 128,
      });
      expect(accessClient.listMyConsents).toHaveBeenNthCalledWith(2, {
        page: 2,
        pageSize: 128,
      });
      expect(prisma.pet.findMany.mock.calls[0][0].where.id.in).toHaveLength(
        130,
      );
    });

    it('hic rizasi olmayan klinik bos liste alir', async () => {
      accessClient.listMyConsents.mockReturnValue(of(consentPage([], 0)));
      prisma.pet.findMany.mockResolvedValue([]);
      prisma.pet.count.mockResolvedValue(0);

      const response = await service.searchClinicPets(baseRequest);

      expect(accessClient.listMyConsents).toHaveBeenCalledTimes(1);
      expect(prisma.pet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [] } } }),
      );
      expect(response).toEqual({ pets: [], total: 0, page: 1, pageSize: 8 });
    });

    it('ad aramasi buyuk-kucuk harf duyarsiz contains ile yapilir', async () => {
      await service.searchClinicPets({ ...baseRequest, name: 'bon' });

      expect(prisma.pet.findMany.mock.calls[0][0].where).toEqual({
        id: { in: [PET_ID, OTHER_PET_ID] },
        name: { contains: 'bon', mode: 'insensitive' },
      });
    });

    it('cip aramasi blind index ile yapilir, duz cip sorguya girmez', async () => {
      await service.searchClinicPets({ ...baseRequest, chipNumber: CHIP });

      expect(chipCrypto.blindIndex).toHaveBeenCalledWith(CHIP);
      expect(prisma.pet.findMany.mock.calls[0][0].where).toEqual({
        id: { in: [PET_ID, OTHER_PET_ID] },
        chipNoIndex: `indeks:${CHIP}`,
      });
    });

    it('tur filtresi uygulanir', async () => {
      await service.searchClinicPets({ ...baseRequest, species: 'CAT' });

      expect(prisma.pet.findMany.mock.calls[0][0].where).toEqual({
        id: { in: [PET_ID, OTHER_PET_ID] },
        species: 'CAT',
      });
    });

    it('orderFilter asc ise eskiden yeniye siralar', async () => {
      await service.searchClinicPets({ ...baseRequest, orderFilter: 'asc' });

      expect(prisma.pet.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('sayfa ve sayfa boyutundan skip ve take hesaplanir', async () => {
      const response = await service.searchClinicPets({
        page: 3,
        pageSize: 16,
      });

      expect(prisma.pet.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({ skip: 32, take: 16 }),
      );
      expect(response).toEqual(
        expect.objectContaining({ page: 3, pageSize: 16 }),
      );
    });

    it.each([
      ['UNAVAILABLE', ResponseMessages.SERVICE_UNAVAILABLE, status.UNAVAILABLE],
      [
        'PERMISSION_DENIED',
        ResponseMessages.INTERNAL_SERVER_ERROR,
        status.PERMISSION_DENIED,
      ],
    ])(
      'access %s donerse %s atar ve veritabanina gitmez',
      async (_n, expected, code) => {
        accessClient.listMyConsents.mockReturnValue(
          throwError(() => grpcError(code)),
        );

        const error = await service
          .searchClinicPets(baseRequest)
          .catch((e) => e);

        expect(error).toBeInstanceOf(RpcException);
        expect(error.message).toBe(expected);
        expect(prisma.pet.findMany).not.toHaveBeenCalled();
      },
    );
  });

  // ---Amaç: sahibin yalnızca kendi petlerini sıralı ve tam çiple aldığını doğrulamak ---
  describe('listMyPets', () => {
    it('yalnizca kullanicinin petlerini en yeniden eskiye siralar ve tam cip doner', async () => {
      prisma.pet.findMany.mockResolvedValue([petRow()]);

      const response = await service.listMyPets(OWNER);

      expect(prisma.pet.findMany).toHaveBeenCalledWith({
        where: { ownerUserId: OWNER_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      expect(response.pets).toHaveLength(1);
      expect(response.pets[0].chipNumber).toBe(CHIP);
    });

    it('peti olmayan kullanici bos liste alir', async () => {
      prisma.pet.findMany.mockResolvedValue([]);

      await expect(service.listMyPets(OWNER)).resolves.toEqual({ pets: [] });
    });
  });

  // ---Amaç: çözülemeyen tek bir çip kaydının cevabı düşürmediğini ve loga çip yazılmadığını doğrulamak ---
  describe('cip cozme hatasi', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      chipCrypto.decryptChip.mockImplementationOnce(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });
    });

    afterEach(() => errorSpy.mockRestore());

    it('listMyPets bozuk kayitta cipi bos, maskeyi dolu doner; diger kayit cozulur', async () => {
      prisma.pet.findMany.mockResolvedValue([
        petRow(),
        petRow({
          id: OTHER_PET_ID,
          chipNoEncrypted: `sifreli:${NEW_CHIP}`,
          chipNoLast4: '7888',
        }),
      ]);

      const { pets: list } = await service.listMyPets(OWNER);

      expect(list[0]).toEqual(
        expect.objectContaining({
          id: PET_ID,
          chipNumber: '',
          chipNumberMasked: '****3444',
        }),
      );
      expect(list[1]).toEqual(
        expect.objectContaining({ id: OTHER_PET_ID, chipNumber: NEW_CHIP }),
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain(`petId=${PET_ID}`);
      expect(errorSpy.mock.calls[0][0]).not.toContain(CHIP);
    });

    it('getPet bozuk kayitta dusmez, maskeyi dondurur', async () => {
      const { pet } = await service.getPet({ id: PET_ID }, OWNER);

      expect(pet).toEqual(
        expect.objectContaining({ chipNumber: '', chipNumberMasked: '****3444' }),
      );
    });
  });

  // ---Amaç: pet sahibinin yalnızca kendi petinin sahiplik bilgisini aldığını doğrulamak ---
  describe('getPetOwner', () => {
    it('sahip petId ve ownerUserId alir', async () => {
      await expect(
        service.getPetOwner({ petId: PET_ID }, OWNER),
      ).resolves.toEqual({ petId: PET_ID, ownerUserId: OWNER_ID });
      expect(prisma.pet.findUnique).toHaveBeenCalledWith({
        where: { id: PET_ID },
      });
    });

    it.each([
      ['pet yok', null, OWNER],
      ['pet baskasinin', petRow(), OTHER_OWNER],
    ])('%s ise NOT_FOUND atar', async (_n, row, user) => {
      prisma.pet.findUnique.mockResolvedValue(row);

      const error = await service
        .getPetOwner({ petId: PET_ID }, user)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
    });
  });

  // ---Amaç: pet kaydının sahiplik, tür-cins-cinsiyet ve çip kurallarıyla yazıldığını doğrulamak ---
  describe('createPet', () => {
    it('alanlari donusturur; cipi sifreli, indeksli ve son 4 haneli yazar', async () => {
      await service.createPet(createRequest(), OWNER);

      expect(prisma.pet.create).toHaveBeenCalledWith({
        data: {
          name: 'Boncuk',
          species: PetSpecies.DOG,
          breed: 'KANGAL',
          sex: DbPetSex.MALE,
          birthDate: new Date('2022-05-10'),
          isBirthDateEstimated: false,
          isNeutered: true,
          ownerUserId: OWNER_ID,
          chipNoEncrypted: `sifreli:${CHIP}`,
          chipNoIndex: `indeks:${CHIP}`,
          chipNoLast4: '3444',
        },
      });
    });

    it('olusturulan peti sahibine tam cip ile dondurur', async () => {
      const { pet } = await service.createPet(createRequest(), OWNER);

      expect(pet).toEqual(
        expect.objectContaining({
          ownerUserId: OWNER_ID,
          chipNumber: CHIP,
          chipNumberMasked: '****3444',
        }),
      );
    });

    it('cipsiz ve dogum tarihsiz kayitta ilgili sutunlar null yazilir', async () => {
      await service.createPet(
        createRequest({ chipNumber: '', birthDate: '' }),
        OWNER,
      );

      expect(prisma.pet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          birthDate: null,
          chipNoEncrypted: null,
          chipNoIndex: null,
          chipNoLast4: null,
        }),
      });
      expect(chipCrypto.encrypt).not.toHaveBeenCalled();
      expect(chipCrypto.blindIndex).not.toHaveBeenCalled();
    });

    it('ownerUserId JWT kullanicisindan farkliysa FORBIDDEN atar ve yazmaz', async () => {
      const error = await service
        .createPet(createRequest({ ownerUserId: OTHER_OWNER_ID }), OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.pet.create).not.toHaveBeenCalled();
    });

    it.each([
      ['listede olmayan tur', { species: 'LION' }],
      ['kucuk harfli tur kodu', { species: 'dog' }],
      ['turun listesinde olmayan cins', { breed: 'SIAMESE' }],
      ['belirtilmemis cinsiyet', { sex: pets.PetSex.PET_SEX_UNSPECIFIED }],
    ])('%s BAD_REQUEST ile reddedilir ve yazilmaz', async (_n, override) => {
      const error = await service
        .createPet(createRequest(override), OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.BAD_REQUEST);
      expect(prisma.pet.create).not.toHaveBeenCalled();
    });

    it.each([
      [
        'cip baska bir pete kayitli',
        ResponseMessages.CONFLICT,
        prismaError('P2002', 'pets_chip_no_index_key'),
      ],
      [
        'baska bir unique ihlali',
        ResponseMessages.INTERNAL_SERVER_ERROR,
        prismaError('P2002', 'pets_pkey'),
      ],
    ])('%s ise %s atar', async (_n, expected, failure) => {
      prisma.pet.create.mockRejectedValue(failure);

      const error = await service
        .createPet(createRequest(), OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(expected);
    });

    it('beklenmeyen hata oldugu gibi yukari tasinir', async () => {
      const original = new Error('veritabani kapali');
      prisma.pet.create.mockRejectedValue(original);

      await expect(service.createPet(createRequest(), OWNER)).rejects.toBe(
        original,
      );
    });
  });

  // ---Amaç: kliniğin yalnızca chip_number_read izniyle ve yalnızca çipi düzeltebildiğini doğrulamak ---
  describe('updatePet - klinik', () => {
    const chipRequest: pets.UpdatePetRequest = {
      id: PET_ID,
      chipNumber: NEW_CHIP,
    };

    it('chip_number_read izni olan klinik cipi duzeltir ve tam cipi gorur', async () => {
      const { pet } = await service.updatePet(chipRequest, CLINIC);

      expect(accessClient.checkAccess).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        requiredScopes: ['chip_number_read'],
      });
      expect(prisma.pet.update).toHaveBeenCalledWith({
        where: { id: PET_ID },
        data: {
          chipNoEncrypted: `sifreli:${NEW_CHIP}`,
          chipNoIndex: `indeks:${NEW_CHIP}`,
          chipNoLast4: '7888',
        },
      });
      expect(pet?.chipNumber).toBe(NEW_CHIP);
    });

    it.each([
      [
        'riza yok',
        { allowed: false, status: access.ConsentStatus.NOT_FOUND },
      ],
      [
        'riza var ama chip_number_read yok',
        { allowed: false, missingScopes: ['chip_number_read'] },
      ],
      [
        'riza iptal edilmis',
        { allowed: false, status: access.ConsentStatus.REVOKED },
      ],
      [
        'riza suresi dolmus',
        { allowed: false, status: access.ConsentStatus.EXPIRED },
      ],
    ])('%s ise FORBIDDEN atar ve yazmaz', async (_n, override) => {
      accessClient.checkAccess.mockReturnValue(
        of(checkAccessResponse(override)),
      );

      const error = await service
        .updatePet(chipRequest, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.FORBIDDEN);
      expect(prisma.pet.update).not.toHaveBeenCalled();
    });

    it.each([
      ['cip disinda bir alan', { id: PET_ID, name: 'Klinik' }],
      [
        'cip ile birlikte baska bir alan',
        { id: PET_ID, chipNumber: NEW_CHIP, isNeutered: false },
      ],
    ])(
      '%s gonderirse FORBIDDEN atar; access-e ve veritabanina gitmez',
      async (_n, request) => {
        const error = await service
          .updatePet(request, CLINIC)
          .catch((e) => e);

        expect(error).toBeInstanceOf(RpcException);
        expect(error.message).toBe(ResponseMessages.FORBIDDEN);
        expect(accessClient.checkAccess).not.toHaveBeenCalled();
        expect(prisma.pet.findUnique).not.toHaveBeenCalled();
        expect(prisma.pet.update).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'cip baska bir pete kayitli',
        ResponseMessages.CONFLICT,
        prismaError('P2002', 'pets_chip_no_index_key'),
      ],
      ['pet artik yok', ResponseMessages.NOT_FOUND, prismaError('P2025')],
    ])('%s ise %s atar', async (_n, expected, failure) => {
      prisma.pet.update.mockRejectedValue(failure);

      const error = await service
        .updatePet(chipRequest, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(expected);
    });

    it('access-e ulasilamazsa SERVICE_UNAVAILABLE atar ve yazmaz', async () => {
      accessClient.checkAccess.mockReturnValue(
        throwError(() => grpcError(status.UNAVAILABLE)),
      );

      const error = await service
        .updatePet(chipRequest, CLINIC)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
      expect(prisma.pet.update).not.toHaveBeenCalled();
    });
  });

  // ---Amaç: sahibin yalnızca kendi petini tür-cins ve doğum tarihi kurallarına uyarak güncelleyebildiğini doğrulamak ---
  describe('updatePet - sahip', () => {
    it.each([
      ['pet yok', null, OWNER],
      ['pet baskasinin', petRow(), OTHER_OWNER],
    ])('%s ise NOT_FOUND atar ve yazmaz', async (_n, row, user) => {
      prisma.pet.findUnique.mockResolvedValue(row);

      const error = await service
        .updatePet({ id: PET_ID, name: 'Calindi' }, user)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(ResponseMessages.NOT_FOUND);
      expect(prisma.pet.update).not.toHaveBeenCalled();
    });

    it('yalnizca gonderilen alani yazar ve guncellemeyi sahiplik kosuluyla yapar', async () => {
      await service.updatePet({ id: PET_ID, name: 'Boncuk Yeni' }, OWNER);

      expect(prisma.pet.findUnique).toHaveBeenCalledWith({
        where: { id: PET_ID },
      });
      expect(prisma.pet.update).toHaveBeenCalledWith({
        where: { id: PET_ID, ownerUserId: OWNER_ID },
        data: { name: 'Boncuk Yeni' },
      });
      expect(prisma.pet.update.mock.calls[0][0].data).not.toHaveProperty(
        'chipNoEncrypted',
      );
      expect(accessClient.checkAccess).not.toHaveBeenCalled();
    });

    it('dogum tarihini Date olarak yazar', async () => {
      await service.updatePet({ id: PET_ID, birthDate: '2021-03-04' }, OWNER);

      expect(prisma.pet.update.mock.calls[0][0].data.birthDate).toEqual(
        new Date('2021-03-04'),
      );
    });

    it('cipi sifreli, indeksli ve son 4 haneli yazar; cevapta tam cip doner', async () => {
      const { pet } = await service.updatePet(
        { id: PET_ID, chipNumber: NEW_CHIP },
        OWNER,
      );
      const { data } = prisma.pet.update.mock.calls[0][0];

      expect(data).toEqual(
        expect.objectContaining({
          chipNoEncrypted: `sifreli:${NEW_CHIP}`,
          chipNoIndex: `indeks:${NEW_CHIP}`,
          chipNoLast4: '7888',
        }),
      );
      expect(data).not.toHaveProperty('chipNumber');
      expect(pet?.chipNumber).toBe(NEW_CHIP);
    });

    it('isNeutered false degeri yazilir', async () => {
      await service.updatePet({ id: PET_ID, isNeutered: false }, OWNER);

      expect(prisma.pet.update.mock.calls[0][0].data.isNeutered).toBe(false);
    });

    it('cins petin kayitli turunun listesindeyse yazilir', async () => {
      await service.updatePet({ id: PET_ID, breed: 'GERMAN_SHEPHERD' }, OWNER);

      expect(prisma.pet.update.mock.calls[0][0].data.breed).toBe(
        'GERMAN_SHEPHERD',
      );
    });

    it('cins petin kayitli turuyle uyusmuyorsa BREED_NOT_VALID atar ve yazmaz', async () => {
      const error = await service
        .updatePet({ id: PET_ID, breed: 'SIAMESE' }, OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(
        getValidationMessage(DtoPrefix.BREED, ValidationType.NOT_VALID),
      );
      expect(prisma.pet.update).not.toHaveBeenCalled();
    });

    it('dogum tarihi olmayan pet tahmini isaretlenirse BIRTH_DATE_NOT_EMPTY atar ve yazmaz', async () => {
      prisma.pet.findUnique.mockResolvedValue(petRow({ birthDate: null }));

      const error = await service
        .updatePet({ id: PET_ID, isBirthDateEstimated: true }, OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(
        getValidationMessage(DtoPrefix.BIRTH_DATE, ValidationType.NOT_EMPTY),
      );
      expect(prisma.pet.update).not.toHaveBeenCalled();
    });

    it.each([
      ['kayitli dogum tarihi var', petRow(), { isBirthDateEstimated: true }],
      [
        'istekte dogum tarihi var',
        petRow({ birthDate: null }),
        { isBirthDateEstimated: true, birthDate: '2023-01-01' },
      ],
      [
        'tahmini isareti false',
        petRow({ birthDate: null }),
        { isBirthDateEstimated: false },
      ],
    ])('%s ise tahmini isareti yazilir', async (_n, row, change) => {
      prisma.pet.findUnique.mockResolvedValue(row);

      await service.updatePet({ id: PET_ID, ...change }, OWNER);

      expect(
        prisma.pet.update.mock.calls[0][0].data.isBirthDateEstimated,
      ).toBe(change.isBirthDateEstimated);
    });

    it.each([
      ['pet bu arada silinmis', ResponseMessages.NOT_FOUND, prismaError('P2025')],
      [
        'cip baska bir pete kayitli',
        ResponseMessages.CONFLICT,
        prismaError('P2002', 'pets_chip_no_index_key'),
      ],
      [
        'baska bir unique ihlali',
        ResponseMessages.INTERNAL_SERVER_ERROR,
        prismaError('P2002', 'pets_pkey'),
      ],
    ])('%s ise %s atar', async (_n, expected, failure) => {
      prisma.pet.update.mockRejectedValue(failure);

      const error = await service
        .updatePet({ id: PET_ID, chipNumber: NEW_CHIP }, OWNER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect(error.message).toBe(expected);
    });

    it('beklenmeyen hata oldugu gibi yukari tasinir', async () => {
      const original = new Error('veritabani kapali');
      prisma.pet.update.mockRejectedValue(original);

      await expect(
        service.updatePet({ id: PET_ID, name: 'Yeni' }, OWNER),
      ).rejects.toBe(original);
    });
  });
});
