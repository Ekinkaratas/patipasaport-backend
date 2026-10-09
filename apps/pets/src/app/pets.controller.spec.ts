import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access, pets } from '@libs/proto';
import { AuthUser, IS_PUBLIC_KEY, Roles } from '@libs/common';
import {
  CreatePetRequestDto,
  GetPetOwnerRequestDto,
  GetPetRequestDto,
  SearchClinicPetsRequestDto,
  UpdatePetRequestDto,
} from '@libs/dto';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';

const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

const OWNER: AuthUser = {
  userId: '8f9e0d1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f',
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
};

const CLINIC: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718',
  clientType: access.ClientType.WEB,
};

type HandlerName =
  | 'getPet'
  | 'searchClinicPets'
  | 'listMyPets'
  | 'getPetOwner'
  | 'createPet'
  | 'updatePet';

const HANDLERS: HandlerName[] = [
  'getPet',
  'searchClinicPets',
  'listMyPets',
  'getPetOwner',
  'createPet',
  'updatePet',
];

describe('PetsController', () => {
  let controller: PetsController;
  let petsService: Record<HandlerName, jest.Mock>;

  beforeEach(async () => {
    petsService = {
      getPet: jest.fn(),
      searchClinicPets: jest.fn(),
      listMyPets: jest.fn(),
      getPetOwner: jest.fn(),
      createPet: jest.fn(),
      updatePet: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PetsController],
      providers: [{ provide: PetsService, useValue: petsService }],
    }).compile();

    controller = moduleRef.get(PetsController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya, role ve kullanıcı parametresine bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydi', () => {
    it.each([
      ['getPet', 'GetPet'],
      ['searchClinicPets', 'SearchClinicPets'],
      ['listMyPets', 'ListMyPets'],
      ['getPetOwner', 'GetPetOwner'],
      ['createPet', 'CreatePet'],
      ['updatePet', 'UpdatePet'],
    ])('%s, PetsService.%s rpc-sine baglidir', (method, rpc) => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA,
        PetsController.prototype[method as HandlerName],
      );

      expect(pattern).toEqual([
        expect.objectContaining({ service: pets.PETS_SERVICE_NAME, rpc }),
      ]);
    });

    it.each([
      ['getPet', [GetPetRequestDto, Object]],
      ['searchClinicPets', [SearchClinicPetsRequestDto]],
      ['listMyPets', [Object]],
      ['getPetOwner', [GetPetOwnerRequestDto, Object]],
      ['createPet', [CreatePetRequestDto, Object]],
      ['updatePet', [UpdatePetRequestDto, Object]],
    ])(
      '%s parametreleri dogrulama icin DTO sinifiyla tiplenmistir',
      (method, paramTypes) => {
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            PetsController.prototype,
            method,
          ),
        ).toEqual(paramTypes);
      },
    );

    it.each([
      ['getPet', ['PET_OWNER', 'CLINIC']],
      ['searchClinicPets', ['CLINIC']],
      ['listMyPets', ['PET_OWNER']],
      ['getPetOwner', ['PET_OWNER']],
      ['createPet', ['PET_OWNER']],
      ['updatePet', ['PET_OWNER', 'CLINIC']],
    ])('%s yalnizca %j rollerine aciktir', (method, roles) => {
      expect(
        new Reflector().get(
          Roles,
          PetsController.prototype[method as HandlerName],
        ),
      ).toEqual(roles);
    });

    it.each(HANDLERS)(
      '%s @Public degildir (dogrulanmis JWT zorunlu)',
      (method) => {
        expect(
          Reflect.getMetadata(IS_PUBLIC_KEY, PetsController.prototype[method]),
        ).toBeUndefined();
      },
    );

    it.each([
      ['getPet', 1],
      ['listMyPets', 0],
      ['getPetOwner', 1],
      ['createPet', 1],
      ['updatePet', 1],
    ])(
      '%s kullaniciyi istek govdesinden degil @CurrentUser ile alir',
      (method, index) => {
        const args: Record<string, { index: number }> = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          PetsController,
          method,
        );
        const userArg = Object.entries(args).find(
          ([, arg]) => arg.index === index,
        );

        expect(userArg?.[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
      },
    );

    it('searchClinicPets kullanici parametresi almaz; riza kapsami JWT ile access-te belirlenir', () => {
      const args: Record<string, { index: number }> = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        PetsController,
        'searchClinicPets',
      );

      expect(
        Object.keys(args).some((key) =>
          key.includes(CUSTOM_ROUTE_ARGS_METADATA),
        ),
      ).toBe(false);
    });
  });

  // ---Amaç: handler'ların isteği ve doğrulanmış kullanıcıyı servise olduğu gibi devrettiğini doğrulamak ---
  describe('servise devretme', () => {
    const cases: [HandlerName, unknown[]][] = [
      ['getPet', [{ id: PET_ID } as GetPetRequestDto, OWNER]],
      [
        'searchClinicPets',
        [{ name: 'bon', page: 1, pageSize: 8 } as SearchClinicPetsRequestDto],
      ],
      ['listMyPets', [OWNER]],
      ['getPetOwner', [{ petId: PET_ID } as GetPetOwnerRequestDto, OWNER]],
      [
        'createPet',
        [
          {
            name: 'Boncuk',
            species: 'DOG',
            breed: 'KANGAL',
            ownerUserId: OWNER.userId,
          } as CreatePetRequestDto,
          OWNER,
        ],
      ],
      [
        'updatePet',
        [
          { id: PET_ID, chipNumber: '900111222333444' } as UpdatePetRequestDto,
          CLINIC,
        ],
      ],
    ];

    it.each(cases)(
      '%s argumanlari servise oldugu gibi devreder ve sonucu dondurur',
      async (method, args) => {
        const result = { sonuc: method };
        petsService[method].mockResolvedValue(result);

        await expect(
          (controller[method] as (...a: unknown[]) => Promise<unknown>)(
            ...args,
          ),
        ).resolves.toBe(result);
        expect(petsService[method]).toHaveBeenCalledWith(...args);
        expect(petsService[method]).toHaveBeenCalledTimes(1);
      },
    );

    it.each(cases)('%s servisten gelen hatayi yutmaz', async (method, args) => {
      const error = new Error('servis hatasi');
      petsService[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        ),
      ).rejects.toBe(error);
    });
  });
});
