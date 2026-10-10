import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access, clinics } from '@libs/proto';
import { AuthUser, IS_PUBLIC_KEY, Roles } from '@libs/common';
import {
  AddStockItemRequestDto,
  CreateClinicRequestDto,
  DeactivateClinicRequestDto,
  GetClinicPetOverviewRequestDto,
  GetClinicRequestDto,
  ListStockItemsRequestDto,
  UploadPetResultRequestDto,
} from '@libs/dto';
import { ClinicsController } from './clinics.controller';
import { ClinicsService } from './clinics.service';

const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

const CLINIC: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: CLINIC_ID,
  clientType: access.ClientType.WEB,
};

type HandlerName =
  | 'getClinic'
  | 'createClinic'
  | 'deactivateClinic'
  | 'addStockItem'
  | 'listStockItems'
  | 'getClinicPetOverview'
  | 'uploadPetResult';

const HANDLERS: HandlerName[] = [
  'getClinic',
  'createClinic',
  'deactivateClinic',
  'addStockItem',
  'listStockItems',
  'getClinicPetOverview',
  'uploadPetResult',
];

describe('ClinicsController', () => {
  let controller: ClinicsController;
  let clinicsService: Record<HandlerName, jest.Mock>;

  beforeEach(async () => {
    clinicsService = Object.fromEntries(
      HANDLERS.map((name) => [name, jest.fn()]),
    ) as Record<HandlerName, jest.Mock>;

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ClinicsController],
      providers: [{ provide: ClinicsService, useValue: clinicsService }],
    }).compile();

    controller = moduleRef.get(ClinicsController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya, role ve kullanıcı parametresine bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydı', () => {
    it.each([
      ['getClinic', 'GetClinic'],
      ['createClinic', 'CreateClinic'],
      ['deactivateClinic', 'DeactivateClinic'],
      ['addStockItem', 'AddStockItem'],
      ['listStockItems', 'ListStockItems'],
      ['getClinicPetOverview', 'GetClinicPetOverview'],
      ['uploadPetResult', 'UploadPetResult'],
    ])('%s, ClinicsService.%s rpc-sine bağlıdır', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        ClinicsController.prototype[method as HandlerName],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: clinics.CLINICS_SERVICE_NAME, rpc }),
      ]);
    });

    it.each([
      ['getClinic', [GetClinicRequestDto, Object]],
      ['createClinic', [CreateClinicRequestDto]],
      ['deactivateClinic', [DeactivateClinicRequestDto, Object]],
      ['addStockItem', [AddStockItemRequestDto, Object]],
      ['listStockItems', [ListStockItemsRequestDto, Object]],
      ['getClinicPetOverview', [GetClinicPetOverviewRequestDto, Object]],
      ['uploadPetResult', [UploadPetResultRequestDto, Object]],
    ])(
      '%s parametreleri doğrulama için DTO sınıfıyla tiplenmiştir',
      (method, paramTypes) => {
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            ClinicsController.prototype,
            method,
          ),
        ).toEqual(paramTypes);
      },
    );

    it.each([
      ['getClinic', ['PET_OWNER', 'CLINIC']],
      ['deactivateClinic', ['CLINIC']],
      ['addStockItem', ['CLINIC']],
      ['listStockItems', ['CLINIC']],
      ['getClinicPetOverview', ['CLINIC']],
      ['uploadPetResult', ['CLINIC']],
    ])('%s yalnızca %j rollerine açıktır', (method, roles) => {
      expect(
        new Reflector().get(
          Roles,
          ClinicsController.prototype[method as HandlerName],
        ),
      ).toEqual(roles);
    });

    it('createClinic iç RPC olarak @Public işaretlidir ve rol kısıtı yoktur', () => {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          ClinicsController.prototype.createClinic,
        ),
      ).toBe(true);
      expect(
        new Reflector().get(Roles, ClinicsController.prototype.createClinic),
      ).toBeUndefined();
    });

    it.each(HANDLERS.filter((name) => name !== 'createClinic'))(
      '%s @Public değildir (doğrulanmış JWT zorunlu)',
      (method) => {
        expect(
          Reflect.getMetadata(
            IS_PUBLIC_KEY,
            ClinicsController.prototype[method],
          ),
        ).toBeUndefined();
      },
    );

    it.each(HANDLERS.filter((name) => name !== 'createClinic'))(
      '%s kullanıcıyı istek gövdesinden değil @CurrentUser ile alır',
      (method) => {
        const args: Record<string, { index: number }> = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          ClinicsController,
          method,
        );
        const userArg = Object.entries(args).find(
          ([, arg]) => arg.index === 1,
        );

        expect(userArg?.[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
      },
    );
  });

  // ---Amaç: handler'ların isteği ve doğrulanmış kullanıcıyı servise olduğu gibi devrettiğini doğrulamak ---
  describe('servise devretme', () => {
    const cases: [HandlerName, unknown[]][] = [
      ['getClinic', [{ id: CLINIC_ID } as GetClinicRequestDto, CLINIC]],
      [
        'createClinic',
        [
          {
            name: 'Pati Klinik',
            taxNumber: '4540536920',
            phone: '+902161234567',
            email: 'klinik@pati.test',
            password: 'Abcdef1!',
          } as CreateClinicRequestDto,
        ],
      ],
      [
        'deactivateClinic',
        [{ clinicId: CLINIC_ID } as DeactivateClinicRequestDto, CLINIC],
      ],
      [
        'addStockItem',
        [
          { clinicId: CLINIC_ID, name: 'Bandaj' } as AddStockItemRequestDto,
          CLINIC,
        ],
      ],
      [
        'listStockItems',
        [
          {
            clinicId: CLINIC_ID,
            page: 1,
            pageSize: 8,
          } as ListStockItemsRequestDto,
          CLINIC,
        ],
      ],
      [
        'getClinicPetOverview',
        [
          {
            clinicId: CLINIC_ID,
            petId: PET_ID,
          } as GetClinicPetOverviewRequestDto,
          CLINIC,
        ],
      ],
      [
        'uploadPetResult',
        [
          { clinicId: CLINIC_ID, petId: PET_ID } as UploadPetResultRequestDto,
          CLINIC,
        ],
      ],
    ];

    it.each(cases)(
      '%s argümanları servise olduğu gibi devreder ve sonucu döndürür',
      async (method, args) => {
        const result = { sonuc: method };
        clinicsService[method].mockResolvedValue(result);

        await expect(
          (controller[method] as (...a: unknown[]) => Promise<unknown>)(
            ...args,
          ),
        ).resolves.toBe(result);
        expect(clinicsService[method]).toHaveBeenCalledWith(...args);
        expect(clinicsService[method]).toHaveBeenCalledTimes(1);
      },
    );

    it.each(cases)('%s servisten gelen hatayı yutmaz', async (method, args) => {
      const error = new Error('servis hatası');
      clinicsService[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        ),
      ).rejects.toBe(error);
    });
  });
});
