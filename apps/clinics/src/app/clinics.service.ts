import {
  AuthUser,
  forwardGrpcError,
  rejectRpc,
  ResponseMessages,
} from '@libs/common';
import { clinics, medicalRecord, pets, users } from '@libs/proto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { firstValueFrom, Observable } from 'rxjs';
import { PrismaService } from './prisma/prisma.service';
import {
  Prisma,
  StockCategory,
  StockItem,
  StockUnit,
} from '../generated/prisma/client';
import { RECENT_RECORD_LIMIT } from './clinics.constants';

type OverviewSource = 'users' | 'medical_record';

interface SourceResult<T> {
  value?: T;
  unavailable?: OverviewSource;
}

@Injectable()
export class ClinicsService implements OnModuleInit {
  private readonly logger = new Logger(ClinicsService.name);
  private petsClient!: pets.PetsServiceClient;
  private usersClient!: users.UsersServiceClient;
  private medicalRecordClient!: medicalRecord.MedicalRecordServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('PETS_SERVICE') private readonly pets_client: ClientGrpc,
    @Inject('USERS_SERVICE') private readonly users_client: ClientGrpc,
    @Inject('MEDICAL_RECORD_SERVICE')
    private readonly medical_record_client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.petsClient = this.pets_client.getService<pets.PetsServiceClient>(
      pets.PETS_SERVICE_NAME,
    );
    this.usersClient = this.users_client.getService<users.UsersServiceClient>(
      users.USERS_SERVICE_NAME,
    );
    this.medicalRecordClient =
      this.medical_record_client.getService<medicalRecord.MedicalRecordServiceClient>(
        medicalRecord.MEDICAL_RECORD_SERVICE_NAME,
      );
  }

  //#region  --- servis içi yardımcı metotlar ---
  private assertOwnClinic(
    clinicId: string,
    user: AuthUser,
    method_name: string,
  ): void {
    if (clinicId !== user.clinicId) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `${method_name}: clinicId uyuşmazlığı (token=${user.clinicId} istek=${clinicId})`,
        'warn',
      );
    }
  }

  private async assertActiveOwnClinic(
    clinicId: string,
    user: AuthUser,
    method_name: string,
  ): Promise<void> {
    this.assertOwnClinic(clinicId, user, method_name);

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { isActive: true },
    });

    if (!clinic) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: klinik bulunamadı (clinicId=${clinicId})`,
      );
    }
    if (!clinic.isActive) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `${method_name}: klinik pasif (clinicId=${clinicId})`,
      );
    }
  }

  private static toProtoStockItem(row: StockItem): clinics.StockItem {
    return {
      id: row.id,
      clinicId: row.clinicId,
      name: row.name,
      category: row.category,
      unit: row.unit,
      quantity: row.quantity,
      criticalLevel: row.criticalLevel,
      isBelowCritical: row.quantity < row.criticalLevel,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : '',
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async fetchPet(petId: string): Promise<pets.Pet> {
    let response: pets.PetResponse;
    try {
      response = await firstValueFrom(this.petsClient.getPet({ id: petId }));
    } catch (e) {
      forwardGrpcError(this.logger, e, 'getClinicPetOverview: pets.getPet', [
        ResponseMessages.NOT_FOUND,
      ]);
    }

    if (!response.pet) {
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `getClinicPetOverview: pets.getPet boş yanıt döndü (petId=${petId})`,
      );
    }
    return response.pet;
  }

  private async fromSource<T>(
    source: OverviewSource,
    call: () => Observable<T>,
  ): Promise<SourceResult<T>> {
    try {
      return { value: await firstValueFrom(call()) };
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === status.PERMISSION_DENIED || code === status.NOT_FOUND) {
        return {};
      }
      this.logger.warn(
        `getClinicPetOverview: ${source} kullanılamıyor (code=${String(code)})`,
      );
      return { unavailable: source };
    }
  }

  private async fetchPetWithOwnerContact(petId: string): Promise<{
    pet: pets.Pet;
    contact: SourceResult<users.GetUserContactResponse>;
  }> {
    const pet = await this.fetchPet(petId);
    const contact = await this.fromSource('users', () =>
      this.usersClient.getUserContact({ userId: pet.ownerUserId, petId }),
    );
    return { pet, contact };
  }

  private static toPetSummary(pet: pets.Pet): clinics.ClinicPetSummary {
    return {
      petId: pet.id,
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      birthDate: pet.birthDate,
      chipNumberMasked: pet.chipNumberMasked,
      ownerUserId: pet.ownerUserId,
    };
  }

  private static toRecordSummary(
    record: medicalRecord.MedicalRecord,
  ): clinics.ClinicRecordSummary {
    return {
      recordId: record.id,
      type: medicalRecord.RecordType[record.type] ?? '',
      title: record.title,
      recordedAt: record.recordedAt,
    };
  }

  //#endregion

  //#region  --- servis metotları ---
  async getClinic(
    request: clinics.GetClinicRequest,
    user: AuthUser,
  ): Promise<clinics.ClinicResponse> {
    const res = await this.prisma.clinic.findUnique({
      where: {
        id: request.id,
      },
    });

    if (!res) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getClinic: clinic bulunamadı. (clinicId: ${request.id})`,
      );
    }

    let newTaxNumber: string = res.taxNumber;
    if (request.id !== user.clinicId) {
      newTaxNumber = res.taxNumber.slice(-4);
    }

    return {
      clinic: {
        id: res.id,
        name: res.fullName,
        taxNumber: newTaxNumber,
        phone: res.telNo,
        email: res.contactEmail,
        isActive: res.isActive,
        createdAt: res.createdAt.toISOString(),
        updatedAt: res.updatedAt.toISOString(),
      },
    };
  }

  async addStockItem(
    request: clinics.AddStockItemRequest,
    user: AuthUser,
  ): Promise<clinics.StockItemResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'addStockItem');

    const row = await this.prisma.stockItem.create({
      data: {
        clinicId: request.clinicId,
        name: request.name,
        category: request.category as StockCategory,
        unit: request.unit as StockUnit,
        quantity: request.quantity,
        criticalLevel: request.criticalLevel,
        expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
        createdBy: user.userId,
      },
    });

    return { item: ClinicsService.toProtoStockItem(row) };
  }

  async listStockItems(
    request: clinics.ListStockItemsRequest,
    user: AuthUser,
  ): Promise<clinics.ListStockItemsResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'listStockItems');

    const where: Prisma.StockItemWhereInput = {
      clinicId: request.clinicId,
      ...(request.category
        ? { category: request.category as StockCategory }
        : {}),
      ...(request.onlyBelowCritical
        ? { quantity: { lt: this.prisma.stockItem.fields.criticalLevel } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockItem.findMany({
        where,
        orderBy: [
          { name: 'asc' },
          { expiresAt: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.stockItem.count({ where }),
    ]);

    return {
      items: rows.map((row) => ClinicsService.toProtoStockItem(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async getClinicPetOverview(
    request: clinics.GetClinicPetOverviewRequest,
    user: AuthUser,
  ): Promise<clinics.GetClinicPetOverviewResponse> {
    this.assertOwnClinic(request.clinicId, user, 'getClinicPetOverview');

    const [{ pet, contact }, records, drafts] = await Promise.all([
      this.fetchPetWithOwnerContact(request.petId),
      this.fromSource('medical_record', () =>
        this.medicalRecordClient.listRecordsByPet({
          petId: request.petId,
          fromDate: '',
          toDate: '',
          page: 1,
          pageSize: RECENT_RECORD_LIMIT,
        }),
      ),
      this.fromSource('medical_record', () =>
        this.medicalRecordClient.listDraftReviews({
          petId: request.petId,
          status: medicalRecord.DraftReviewStatus.PENDING,
          page: 1,
          pageSize: RECENT_RECORD_LIMIT,
        }),
      ),
    ]);

    return {
      pet: ClinicsService.toPetSummary(pet),
      owner: contact.value
        ? {
            userId: contact.value.userId,
            fullName: contact.value.fullName,
            phone: contact.value.phone,
          }
        : undefined,
      recentRecords: (records.value?.records ?? []).map((record) =>
        ClinicsService.toRecordSummary(record),
      ),
      pendingDraftReviewCount: drafts.value?.total ?? 0,
      unavailableSources: [
        ...new Set(
          [contact, records, drafts].flatMap((result) =>
            result.unavailable ? [result.unavailable] : [],
          ),
        ),
      ],
    };
  }

  async uploadPetResult(
    request: clinics.UploadPetResultRequest,
    user: AuthUser,
  ): Promise<clinics.UploadPetResultResponse> {
    this.assertOwnClinic(request.clinicId, user, 'uploadPetResult');

    rejectRpc(
      this.logger,
      ResponseMessages.METHOD_NOT_ALLOWED,
      `uploadPetResult: medical record iletimi henüz tasarlanmadı (petId=${request.petId})`,
      'warn',
    );
  }

  //#endregion
}
