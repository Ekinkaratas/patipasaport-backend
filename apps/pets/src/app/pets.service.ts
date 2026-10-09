import {
  AuthUser,
  DtoPrefix,
  forwardGrpcError,
  getValidationMessage,
  PET_BREEDS,
  rejectRpc,
  ResponseMessages,
  SortOrder,
  ValidationType,
} from '@libs/common';
import { access, pets } from '@libs/proto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  Pet,
  PetSex as DbPetSex,
  PetSpecies,
  Prisma,
} from '../generated/prisma/client';
import { firstValueFrom } from 'rxjs';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { ChipCryptoService } from './crypto/chip-crypto.service';

@Injectable()
export class PetsService {
  private readonly logger = new Logger(PetsService.name);
  private accessClient!: access.AccessServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('ACCESS_SERVICE') private readonly access_client: ClientGrpc,
    private readonly chipCrypto: ChipCryptoService,
  ) {}

  async onModuleInit() {
    this.accessClient =
      this.access_client.getService<access.AccessServiceClient>(
        access.ACCESS_SERVICE_NAME,
      );
  }

  //#region --- servis içi yardımcı metotlar ---

  private async checkChipAccess(
    petId: string,
    clinicId: string,
    method_name: string,
  ): Promise<access.CheckAccessResponse> {
    try {
      return await firstValueFrom(
        this.accessClient.checkAccess({
          clinicId: clinicId,
          petId: petId,
          requiredScopes: ['chip_number_read'],
        }),
      );
    } catch (e) {
      forwardGrpcError(this.logger, e, `${method_name}: access.checkAccess`);
    }
  }

  private async isChipNumberReadVerify(
    petId: string,
    clinicId: string,
    method_name: string,
  ): Promise<boolean> {
    const consent = await this.checkChipAccess(petId, clinicId, method_name);

    if (consent.status !== access.ConsentStatus.ACTIVE) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: klinik için geçerli rıza yok (clinicId=${clinicId} petId=${petId})`,
      );
    }

    return consent.allowed;
  }

  private toProtoPet(row: Pet, revealChip: boolean): pets.Pet {
    return {
      id: row.id,
      name: row.name,
      species: row.species,
      breed: row.breed,
      sex: row.sex === DbPetSex.MALE ? pets.PetSex.MALE : pets.PetSex.FEMALE,
      birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : '',
      isBirthDateEstimated: row.isBirthDateEstimated,
      isNeutered: row.isNeutered,
      ownerUserId: row.ownerUserId,
      chipNumberMasked: row.chipNoLast4 ? `****${row.chipNoLast4}` : '',
      chipNumber:
        revealChip && row.chipNoEncrypted
          ? this.decryptChipOrEmpty(row.id, row.chipNoEncrypted)
          : '',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private decryptChipOrEmpty(petId: string, stored: string): string {
    try {
      return this.chipCrypto.decryptChip(stored);
    } catch (e) {
      this.logger.error(
        `toProtoPet: çip numarası çözülemedi (petId=${petId}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return '';
    }
  }

  private toPetSummary(row: Pet): pets.PetSummary {
    return {
      id: row.id,
      name: row.name,
      species: row.species,
      breed: row.breed,
      sex: row.sex === DbPetSex.MALE ? pets.PetSex.MALE : pets.PetSex.FEMALE,
      birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : '',
      isBirthDateEstimated: row.isBirthDateEstimated,
      chipNumberMasked: row.chipNoLast4 ? `****${row.chipNoLast4}` : '',
    };
  }

  private checkSpecies(protoSpecies: string): PetSpecies | undefined {
    return Object.values(PetSpecies).find(
      (species) => species === protoSpecies,
    );
  }

  private checkBreed(species: PetSpecies, breed: string): string | undefined {
    const allowedBreeds = PET_BREEDS[species];

    return (allowedBreeds as readonly string[]).find((text) => text === breed);
  }

  private reverseSexProtoToDb(protoSex: pets.PetSex): DbPetSex | null {
    switch (protoSex) {
      case pets.PetSex.MALE:
        return DbPetSex.MALE;
      case pets.PetSex.FEMALE:
        return DbPetSex.FEMALE;
      default:
        return null;
    }
  }

  private async getConsentedPetIds(): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      let res: access.ListMyConsentsResponse;
      try {
        res = await firstValueFrom(
          this.accessClient.listMyConsents({ page, pageSize: 128 }),
        );
      } catch (e) {
        forwardGrpcError(
          this.logger,
          e,
          'searchClinicPets: access.listMyConsents',
        );
      }
      ids.push(...res.consents.map((consent) => consent.petId));
      if (page * 128 >= res.total) return ids;
    }
  }

  private rejectInvalidArgument(message: string, reason: string): never {
    this.logger.log(`Reddedildi (${message}): ${reason}`);
    throw new RpcException(message);
  }

  private rejectPetWriteError(
    e: unknown,
    method_name: string,
    detail: string,
  ): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `${method_name}: pet bulunamadı (${detail})`,
        );
      }
      if (e.code === 'P2002') {
        const constraint = (
          e.meta as
            | {
                driverAdapterError?: {
                  cause?: { constraint?: { index?: string } };
                };
              }
            | undefined
        )?.driverAdapterError?.cause?.constraint?.index;

        if (constraint === 'pets_chip_no_index_key') {
          rejectRpc(
            this.logger,
            ResponseMessages.CONFLICT,
            `${method_name}: çip numarası başka bir pete kayıtlı (${detail})`,
            'warn',
          );
        }
        rejectRpc(
          this.logger,
          ResponseMessages.INTERNAL_SERVER_ERROR,
          `${method_name}: beklenmeyen unique ihlali (constraint=${String(constraint)})`,
        );
      }
    }
    throw e;
  }

  //#endregion

  //#region   ---  servis metotları  ---
  async getPet(
    request: pets.GetPetRequest,
    user: AuthUser,
  ): Promise<pets.PetResponse> {
    const pets_db_res: Pet | null = await this.prisma.pet.findUnique({
      where: {
        id: request.id,
      },
    });

    if (!pets_db_res) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getPet: pet bulunamadı(pet_id: ${request.id})`,
      );
    }

    let revealChip = false;
    if (user.role === 'PET_OWNER') {
      if (pets_db_res.ownerUserId !== user.userId) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `getPet: IDOR girişimi (userId=${user.userId} petId=${pets_db_res.id})`,
          'warn',
        );
      }
      revealChip = true;
    } else {
      const is_verify: boolean = await this.isChipNumberReadVerify(
        request.id,
        user.clinicId,
        'getPet',
      );

      revealChip = is_verify;
    }

    return { pet: this.toProtoPet(pets_db_res, revealChip) };
  }

  async searchClinicPets(
    request: pets.SearchClinicPetsRequest,
  ): Promise<pets.SearchClinicPetsResponse> {
    const consentedPetIds = await this.getConsentedPetIds();

    const where: Prisma.PetWhereInput = {
      id: { in: consentedPetIds },
      ...(request.name
        ? { name: { contains: request.name, mode: 'insensitive' } }
        : {}),
      ...(request.chipNumber
        ? { chipNoIndex: this.chipCrypto.blindIndex(request.chipNumber) }
        : {}),
      ...(request.species ? { species: request.species as PetSpecies } : {}),
    };
    const order = (request.orderFilter as SortOrder | undefined) ?? 'desc';

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pet.findMany({
        where,
        orderBy: [{ createdAt: order }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.pet.count({ where }),
    ]);

    return {
      pets: rows.map((row) => this.toPetSummary(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async listMyPets(user: AuthUser): Promise<pets.ListMyPetsResponse> {
    const rows = await this.prisma.pet.findMany({
      where: {
        ownerUserId: user.userId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });

    return { pets: rows.map((row) => this.toProtoPet(row, true)) };
  }

  async getPetOwner(
    request: pets.GetPetOwnerRequest,
    user: AuthUser,
  ): Promise<pets.GetPetOwnerResponse> {
    const pet: Pet | null = await this.prisma.pet.findUnique({
      where: {
        id: request.petId,
      },
    });

    if (!pet || pet.ownerUserId !== user.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getPetOwner: pet yok ya da kullanıcıya ait değil (userId=${user.userId} petId=${request.petId})`,
        pet ? 'warn' : undefined,
      );
    }

    const response: pets.GetPetOwnerResponse = {
      petId: request.petId,
      ownerUserId: pet.ownerUserId,
    };

    return response;
  }

  async createPet(
    request: pets.CreatePetRequest,
    user: AuthUser,
  ): Promise<pets.PetResponse> {
    if (request.ownerUserId !== user.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `createPet: yetkisiz pet oluşturma denemesi (request.ownerUserId = ${request.ownerUserId}, user.userId = ${user.userId})`,
      );
    }

    const species = this.checkSpecies(request.species);

    if (!species) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        `createPet: Geçersiz evcil hayvan türü gönderildi (species='${request.species}'). Kabul edilen türler: ${Object.values(PetSpecies).join(', ')}`,
        'warn',
      );
    }

    const breed = this.checkBreed(species, request.breed);

    if (!breed) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        `createPet: Belirtilen tür için geçersiz ırk/cins (species='${request.species}', breed='${request.breed}').`,
        'warn',
      );
    }

    const sex: DbPetSex | null = this.reverseSexProtoToDb(request.sex);

    if (!sex) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        `createPet: Belirtilen hayvan için geçersiz cinsiyet (sex='${request.sex}')`,
        'warn',
      );
    }

    const db_payload = {
      name: request.name,
      species: species,
      breed: breed,
      sex: sex,
      birthDate: request.birthDate ? new Date(request.birthDate) : null,
      isBirthDateEstimated: request.isBirthDateEstimated,
      isNeutered: request.isNeutered,
      ownerUserId: request.ownerUserId,
      chipNoEncrypted: request.chipNumber
        ? this.chipCrypto.encrypt(request.chipNumber)
        : null,
      chipNoIndex: request.chipNumber
        ? this.chipCrypto.blindIndex(request.chipNumber)
        : null,
      chipNoLast4: request.chipNumber
        ? ChipCryptoService.last4(request.chipNumber)
        : null,
    };

    let pet: Pet;
    try {
      pet = await this.prisma.pet.create({
        data: {
          ...db_payload,
        },
      });
    } catch (e) {
      this.rejectPetWriteError(e, 'createPet', `ownerUserId=${user.userId}`);
    }

    return { pet: this.toProtoPet(pet, true) };
  }

  async updatePet(
    request: pets.UpdatePetRequest,
    user: AuthUser,
  ): Promise<pets.PetResponse> {
    const filledKeys = Object.entries(request)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .filter(([_, val]) => val !== null && val !== undefined && val !== '')
      .map(([key]) => key);

    if (
      user.clinicId &&
      filledKeys.length === 2 &&
      filledKeys.includes('chipNumber')
    ) {
      const chipNumber = request.chipNumber as string;

      const consent = await this.checkChipAccess(
        request.id,
        user.clinicId,
        'updatePet',
      );

      if (!consent.allowed) {
        rejectRpc(
          this.logger,
          ResponseMessages.FORBIDDEN,
          `Yetkisiz çip no güncelleme girişimi! (clinicId=${user.clinicId}, petId=${request.id})`,
          'warn',
        );
      }
      let updatePet: Pet;
      try {
        updatePet = await this.prisma.pet.update({
          where: {
            id: request.id,
          },

          data: {
            chipNoEncrypted: this.chipCrypto.encrypt(chipNumber),
            chipNoIndex: this.chipCrypto.blindIndex(chipNumber),
            chipNoLast4: ChipCryptoService.last4(chipNumber),
          },
        });
      } catch (e) {
        this.rejectPetWriteError(e, 'updatePet', `petId=${request.id}`);
      }

      return { pet: this.toProtoPet(updatePet, true) };
    }
    if (!user.clinicId) {
      const pet: Pet | null = await this.prisma.pet.findUnique({
        where: {
          id: request.id,
        },
      });

      if (!pet || pet.ownerUserId !== user.userId) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `updatePet: pet yok ya da kullanıcıya ait değil (userId=${user.userId} petId=${request.id})`,
          pet ? 'warn' : undefined,
        );
      }

      const breed = request.breed
        ? this.checkBreed(pet.species, request.breed)
        : undefined;

      if (request.breed && !breed) {
        this.rejectInvalidArgument(
          getValidationMessage(DtoPrefix.BREED, ValidationType.NOT_VALID),
          `updatePet: cins petin kayıtlı türüyle uyumsuz (petId=${pet.id} species=${pet.species})`,
        );
      }

      if (
        request.isBirthDateEstimated &&
        !request.birthDate &&
        !pet.birthDate
      ) {
        this.rejectInvalidArgument(
          getValidationMessage(DtoPrefix.BIRTH_DATE, ValidationType.NOT_EMPTY),
          `updatePet: doğum tarihi olmayan pet tahmini olarak işaretlenemez (petId=${pet.id})`,
        );
      }

      let updatePet: Pet;
      try {
        updatePet = await this.prisma.pet.update({
          where: {
            id: request.id,
            ownerUserId: user.userId,
          },

          data: {
            name: request.name,
            breed: breed,
            birthDate: request.birthDate
              ? new Date(request.birthDate)
              : undefined,
            isBirthDateEstimated: request.isBirthDateEstimated,
            isNeutered: request.isNeutered,
            ...(request.chipNumber
              ? {
                  chipNoEncrypted: this.chipCrypto.encrypt(request.chipNumber),
                  chipNoIndex: this.chipCrypto.blindIndex(request.chipNumber),
                  chipNoLast4: ChipCryptoService.last4(request.chipNumber),
                }
              : {}),
          },
        });
      } catch (e) {
        this.rejectPetWriteError(e, 'updatePet', `petId=${request.id}`);
      }

      return { pet: this.toProtoPet(updatePet, true) };
    }

    rejectRpc(
      this.logger,
      ResponseMessages.FORBIDDEN,
      `updatePet: clinic bir hayvanın chip numarası dışında bir değişiklik yapmaya çalıştı(clinicId: ${user.clinicId})`,
      'warn',
    );
  }

  //#endregion
}
