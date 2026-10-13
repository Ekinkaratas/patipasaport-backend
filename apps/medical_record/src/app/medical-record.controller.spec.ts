import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { access, medicalRecord } from '@libs/proto';
import { AuthUser, IS_PUBLIC_KEY, Roles } from '@libs/common';
import {
  CreateRecordRequestDto,
  GetDocumentRequestDto,
  ListDraftReviewsRequestDto,
  ListLabResultsRequestDto,
  ListPrescriptionsRequestDto,
  ListRecordsByPetRequestDto,
  ListVaccinationsRequestDto,
  RegisterDocumentRequestDto,
  ReviewDraftRequestDto,
} from '@libs/dto';
import { MedicalRecordController } from './medical-record.controller';
import { MedicalRecordService } from './medical-record.service';

const CLINIC: AuthUser = {
  userId: '3f1c2b4a-8d6e-4f7a-9b0c-1d2e3f4a5b6c',
  role: 'CLINIC',
  clinicId: '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718',
  clientType: access.ClientType.WEB,
};

type HandlerName =
  | 'listRecordsByPet'
  | 'createRecord'
  | 'listVaccinations'
  | 'listPrescriptions'
  | 'listLabResults'
  | 'registerDocument'
  | 'getDocument'
  | 'listDraftReviews'
  | 'reviewDraft';

const HANDLERS: [HandlerName, string, unknown, string[]][] = [
  [
    'listRecordsByPet',
    'ListRecordsByPet',
    ListRecordsByPetRequestDto,
    ['PET_OWNER', 'CLINIC'],
  ],
  ['createRecord', 'CreateRecord', CreateRecordRequestDto, ['CLINIC']],
  [
    'listVaccinations',
    'ListVaccinations',
    ListVaccinationsRequestDto,
    ['PET_OWNER', 'CLINIC'],
  ],
  [
    'listPrescriptions',
    'ListPrescriptions',
    ListPrescriptionsRequestDto,
    ['PET_OWNER', 'CLINIC'],
  ],
  [
    'listLabResults',
    'ListLabResults',
    ListLabResultsRequestDto,
    ['PET_OWNER', 'CLINIC'],
  ],
  [
    'registerDocument',
    'RegisterDocument',
    RegisterDocumentRequestDto,
    ['CLINIC'],
  ],
  ['getDocument', 'GetDocument', GetDocumentRequestDto, ['CLINIC']],
  [
    'listDraftReviews',
    'ListDraftReviews',
    ListDraftReviewsRequestDto,
    ['CLINIC'],
  ],
  ['reviewDraft', 'ReviewDraft', ReviewDraftRequestDto, ['CLINIC']],
];

describe('MedicalRecordController', () => {
  let controller: MedicalRecordController;
  let service: Record<HandlerName, jest.Mock>;

  beforeEach(async () => {
    service = Object.fromEntries(
      HANDLERS.map(([name]) => [name, jest.fn()]),
    ) as Record<HandlerName, jest.Mock>;

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MedicalRecordController],
      providers: [{ provide: MedicalRecordService, useValue: service }],
    }).compile();

    controller = moduleRef.get(MedicalRecordController);
  });

  // ---Amaç: handler'ların doğru RPC'ye, DTO'ya, role ve kullanıcı parametresine bağlı olduğunu doğrulamak ---
  describe('gRPC handler kaydı', () => {
    it.each(HANDLERS)(
      '%s, MedicalRecordService.%s rpc-sine bağlıdır',
      (method, rpc) => {
        expect(
          Reflect.getMetadata(
            PATTERN_METADATA,
            MedicalRecordController.prototype[method],
          ),
        ).toEqual([
          expect.objectContaining({
            service: medicalRecord.MEDICAL_RECORD_SERVICE_NAME,
            rpc,
          }),
        ]);
      },
    );

    it.each(HANDLERS)(
      '%s isteği DTO sınıfıyla doğrulanır',
      (method, _rpc, dto) => {
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            MedicalRecordController.prototype,
            method,
          ),
        ).toEqual([dto, Object]);
      },
    );

    it.each(HANDLERS)('%s rol kısıtı doğrudur', (method, _rpc, _dto, roles) => {
      expect(
        new Reflector().get(Roles, MedicalRecordController.prototype[method]),
      ).toEqual(roles);
    });

    it.each(HANDLERS)(
      '%s @Public değildir ve kullanıcıyı @CurrentUser ile alır',
      (method) => {
        expect(
          Reflect.getMetadata(
            IS_PUBLIC_KEY,
            MedicalRecordController.prototype[method],
          ),
        ).toBeUndefined();
        const args: Record<string, { index: number }> = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          MedicalRecordController,
          method,
        );
        const userArg = Object.entries(args).find(([, arg]) => arg.index === 1);
        expect(userArg?.[0]).toContain(CUSTOM_ROUTE_ARGS_METADATA);
      },
    );
  });

  // ---Amaç: handler'ların isteği ve kullanıcıyı servise olduğu gibi devrettiğini, hatayı yutmadığını doğrulamak ---
  describe('servise devretme', () => {
    it.each(HANDLERS)(
      '%s argümanları servise devreder ve sonucu döndürür',
      async (method) => {
        const request = { istek: method };
        const result = { sonuc: method };
        service[method].mockResolvedValue(result);

        await expect(
          (controller[method] as (...a: unknown[]) => Promise<unknown>)(
            request,
            CLINIC,
          ),
        ).resolves.toBe(result);
        expect(service[method]).toHaveBeenCalledWith(request, CLINIC);
      },
    );

    it.each(HANDLERS)('%s servisten gelen hatayı yutmaz', async (method) => {
      const error = new Error(`${method} hatası`);
      service[method].mockRejectedValue(error);

      await expect(
        (controller[method] as (...a: unknown[]) => Promise<unknown>)(
          {},
          CLINIC,
        ),
      ).rejects.toBe(error);
    });
  });
});
