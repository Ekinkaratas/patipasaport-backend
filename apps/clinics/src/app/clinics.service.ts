import {
  AuthUser,
  forwardGrpcError,
  rejectRpc,
  ResponseMessages,
  rollbackLocal,
} from '@libs/common';
import { auth, clinics, medicalRecord, pets, users } from '@libs/proto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { randomInt } from 'crypto';
import { firstValueFrom, Observable } from 'rxjs';
import { PrismaService } from './prisma/prisma.service';
import {
  Clinic,
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
  private authClient!: auth.AuthServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('PETS_SERVICE') private readonly pets_client: ClientGrpc,
    @Inject('USERS_SERVICE') private readonly users_client: ClientGrpc,
    @Inject('MEDICAL_RECORD_SERVICE')
    private readonly medical_record_client: ClientGrpc,
    @Inject('AUTH_SERVICE') private readonly auth_client: ClientGrpc,
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
    this.authClient = this.auth_client.getService<auth.AuthServiceClient>(
      auth.AUTH_SERVICE_NAME,
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

  private static toProtoClinic(row: Clinic): clinics.Clinic {
    return {
      id: row.id,
      name: row.fullName,
      taxNumber: row.taxNumber,
      phone: row.telNo,
      email: row.contactEmail,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private static uniqueConstraintName(
    e: Prisma.PrismaClientKnownRequestError,
  ): string | undefined {
    const meta = e.meta as
      | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
      | undefined;
    return meta?.driverAdapterError?.cause?.constraint?.index;
  }

  private static isTaxNumberCollision(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      ClinicsService.uniqueConstraintName(e) === 'clinics_tax_number_key'
    );
  }

  private static anonymizedTaxNumber(): string {
    return `X${Array.from({ length: 10 }, () => randomInt(0, 10)).join('')}`;
  }

  private rejectClinicConflict(e: unknown, method_name: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const constraint = ClinicsService.uniqueConstraintName(e);

      if (constraint === 'clinics_tax_number_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.TAX_NUMBER_ALREADY_EXISTS,
          `${method_name}: vergi numarası zaten kayıtlı`,
        );
      }
      if (constraint === 'clinics_contact_email_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          `${method_name}: e-posta zaten kayıtlı`,
        );
      }
      if (constraint === 'clinics_tel_no_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.PHONE_ALREADY_EXISTS,
          `${method_name}: telefon zaten kayıtlı`,
        );
      }
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `${method_name}: beklenmeyen unique ihlali (constraint=${String(constraint)})`,
      );
    }
    throw e;
  }

  private async deactivateWithAnonymizedTaxNumber(
    clinicId: string,
  ): Promise<Clinic> {
    const update = () =>
      this.prisma.clinic.update({
        where: { id: clinicId },
        data: {
          isActive: false,
          taxNumber: ClinicsService.anonymizedTaxNumber(),
        },
      });

    try {
      return await update();
    } catch (e) {
      if (ClinicsService.isTaxNumberCollision(e)) {
        return update();
      }
      throw e;
    }
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

  async createClinic(
    request: clinics.CreateClinicRequest,
  ): Promise<clinics.ClinicResponse> {
    let clinic: Clinic;
    try {
      clinic = await this.prisma.clinic.create({
        data: {
          fullName: request.name,
          taxNumber: request.taxNumber,
          contactEmail: request.email,
          telNo: request.phone,
        },
      });
    } catch (e) {
      this.rejectClinicConflict(e, 'createClinic');
    }

    try {
      await firstValueFrom(
        this.authClient.registerClinicAccount({
          clinicId: clinic.id,
          email: request.email,
          password: request.password,
          fullName: request.name,
          phone: request.phone,
        }),
      );
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === status.DEADLINE_EXCEEDED) {
        this.logger.error(
          `createClinic: auth.registerClinicAccount zaman aşımına uğradı, hesap oluşmuş ve sahipsiz kalmış olabilir (clinicId=${clinic.id})`,
        );
      }
      await rollbackLocal(
        this.logger,
        () => this.prisma.clinic.delete({ where: { id: clinic.id } }),
        `createClinic: klinik hesabı açılamadı, klinik satırı geri alınıyor (clinicId=${clinic.id})`,
      );
      forwardGrpcError(
        this.logger,
        e,
        'createClinic: auth.registerClinicAccount',
        [
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          ResponseMessages.PHONE_ALREADY_EXISTS,
        ],
      );
    }

    return { clinic: ClinicsService.toProtoClinic(clinic) };
  }

  async deactivateClinic(
    request: clinics.DeactivateClinicRequest,
    user: AuthUser,
  ): Promise<clinics.ClinicResponse> {
    this.assertOwnClinic(request.clinicId, user, 'deactivateClinic');

    let clinic = await this.prisma.clinic.findUnique({
      where: { id: request.clinicId },
    });

    if (!clinic) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `deactivateClinic: klinik bulunamadı (clinicId=${request.clinicId})`,
      );
    }

    if (clinic.isActive) {
      clinic = await this.deactivateWithAnonymizedTaxNumber(clinic.id);
    }

    try {
      await firstValueFrom(
        this.usersClient.deactivateClinicUsers({ clinicId: clinic.id }),
      );
    } catch (e) {
      forwardGrpcError(
        this.logger,
        e,
        'deactivateClinic: users.deactivateClinicUsers',
      );
    }

    return { clinic: ClinicsService.toProtoClinic(clinic) };
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
