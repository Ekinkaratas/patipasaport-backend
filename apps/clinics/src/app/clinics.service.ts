import {
  AuthUser,
  DtoPrefix,
  forwardGrpcError,
  getValidationMessage,
  rejectRpc,
  ResponseMessages,
  rollbackLocal,
  ValidationType,
} from '@libs/common';
import {
  BUSINESS_TIME_ZONE,
  STOCK_AMOUNT_MAX,
  todayInBusinessTimeZone,
} from '@libs/dto';
import { auth, clinics, medicalRecord, pets, users } from '@libs/proto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { randomInt } from 'crypto';
import { firstValueFrom, Observable } from 'rxjs';
import { PrismaService } from './prisma/prisma.service';
import {
  Clinic,
  Prisma,
  StockCategory,
  StockItem,
  StockSale,
  StockUnit,
} from '../generated/prisma/client';
import { RECENT_RECORD_LIMIT } from './clinics.constants';
import {
  addDays,
  businessMonth,
  monthDays,
  monthWeeks,
  nextMonth,
  zonedMidnightToUtc,
} from './stock-sales.dates';

interface SalesAggregateRow {
  revenue: bigint;
  cost: bigint;
  salesCount: number;
  quantity: bigint;
}

interface DailySalesRow extends SalesAggregateRow {
  day: string;
}

interface ProductSalesRow extends SalesAggregateRow {
  stockItemId: string | null;
  itemName: string;
  unit: string;
}

interface SalesFigures {
  revenue: number;
  cost: number;
  profit: number;
  salesCount: number;
  quantity: number;
}

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
      purchasePrice: row.purchasePrice ?? undefined,
      salePrice: row.salePrice ?? undefined,
    };
  }

  private static toProtoSale(row: StockSale): clinics.StockSale {
    const totalSale = row.quantity * row.unitSalePrice;
    const totalCost = row.quantity * row.unitPurchasePrice;
    return {
      id: row.id,
      clinicId: row.clinicId,
      stockItemId: row.stockItemId ?? '',
      itemName: row.itemName,
      category: row.category,
      unit: row.unit,
      quantity: row.quantity,
      unitSalePrice: row.unitSalePrice,
      unitPurchasePrice: row.unitPurchasePrice,
      totalSale,
      totalCost,
      profit: totalSale - totalCost,
      soldAt: row.soldAt.toISOString(),
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : '',
    };
  }

  private static toFigures(row?: SalesAggregateRow): SalesFigures {
    const revenue = Number(row?.revenue ?? 0);
    const cost = Number(row?.cost ?? 0);
    return {
      revenue,
      cost,
      profit: revenue - cost,
      salesCount: row?.salesCount ?? 0,
      quantity: Number(row?.quantity ?? 0),
    };
  }

  private static sumFigures(figures: SalesFigures[]): SalesFigures {
    return figures.reduce(
      (total, item) => ({
        revenue: total.revenue + item.revenue,
        cost: total.cost + item.cost,
        profit: total.profit + item.profit,
        salesCount: total.salesCount + item.salesCount,
        quantity: total.quantity + item.quantity,
      }),
      { revenue: 0, cost: 0, profit: 0, salesCount: 0, quantity: 0 },
    );
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
        purchasePrice: request.purchasePrice,
        salePrice: request.salePrice,
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

  async updateStockItem(
    request: clinics.UpdateStockItemRequest,
    user: AuthUser,
  ): Promise<clinics.StockItemResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'updateStockItem');

    const data: Prisma.StockItemUpdateInput = {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
      ...(request.criticalLevel !== undefined
        ? { criticalLevel: request.criticalLevel }
        : {}),
      ...(request.expiresAt !== undefined
        ? { expiresAt: request.expiresAt ? new Date(request.expiresAt) : null }
        : {}),
      ...(request.purchasePrice !== undefined
        ? { purchasePrice: request.purchasePrice }
        : {}),
      ...(request.salePrice !== undefined
        ? { salePrice: request.salePrice }
        : {}),
    };

    if (Object.keys(data).length === 0) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        `updateStockItem: güncellenecek alan yok (itemId=${request.itemId})`,
      );
    }

    try {
      const row = await this.prisma.stockItem.update({
        where: { id: request.itemId, clinicId: request.clinicId },
        data,
      });
      return { item: ClinicsService.toProtoStockItem(row) };
    } catch (e) {
      this.rejectIfStockItemMissing(e, request.itemId, 'updateStockItem');
      throw e;
    }
  }

  async adjustStockItem(
    request: clinics.AdjustStockItemRequest,
    user: AuthUser,
  ): Promise<clinics.StockItemResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'adjustStockItem');

    const where = { id: request.itemId, clinicId: request.clinicId };
    const { count } = await this.prisma.stockItem.updateMany({
      where: {
        ...where,
        quantity:
          request.delta < 0
            ? { gte: -request.delta }
            : { lte: STOCK_AMOUNT_MAX - request.delta },
      },
      data: { quantity: { increment: request.delta } },
    });

    if (count === 0) {
      const exists = await this.prisma.stockItem.count({ where });
      if (exists === 0) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `adjustStockItem: stok kalemi bulunamadı (itemId=${request.itemId})`,
        );
      }
      this.logger.warn(
        `Reddedildi: adjustStockItem miktarı sınır dışına çıkarırdı (itemId=${request.itemId} delta=${request.delta})`,
      );
      throw new RpcException(
        request.delta < 0
          ? getValidationMessage(DtoPrefix.QUANTITY, ValidationType.MIN, 0)
          : getValidationMessage(
              DtoPrefix.QUANTITY,
              ValidationType.MAX,
              STOCK_AMOUNT_MAX,
            ),
      );
    }

    const row = await this.prisma.stockItem.findFirst({ where });
    if (!row) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `adjustStockItem: stok kalemi güncellemeden sonra bulunamadı (itemId=${request.itemId})`,
      );
    }
    return { item: ClinicsService.toProtoStockItem(row) };
  }

  async deleteStockItem(
    request: clinics.DeleteStockItemRequest,
    user: AuthUser,
  ): Promise<clinics.StockItemResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'deleteStockItem');

    try {
      const row = await this.prisma.stockItem.delete({
        where: { id: request.itemId, clinicId: request.clinicId },
      });
      return { item: ClinicsService.toProtoStockItem(row) };
    } catch (e) {
      this.rejectIfStockItemMissing(e, request.itemId, 'deleteStockItem');
      throw e;
    }
  }

  async createStockSale(
    request: clinics.CreateStockSaleRequest,
    user: AuthUser,
  ): Promise<clinics.StockSaleResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'createStockSale');

    return this.prisma.$transaction(async (tx) => {
      const where = { id: request.itemId, clinicId: request.clinicId };
      const item = await tx.stockItem.findFirst({ where });
      if (!item) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `createStockSale: stok kalemi bulunamadı (itemId=${request.itemId})`,
        );
      }
      if (item.purchasePrice === null || item.salePrice === null) {
        this.logger.warn(
          `Reddedildi: createStockSale kalemin fiyatı tanımlı değil (itemId=${request.itemId})`,
        );
        throw new RpcException(
          getValidationMessage(
            item.purchasePrice === null
              ? DtoPrefix.PURCHASE_PRICE
              : DtoPrefix.SALE_PRICE,
            ValidationType.NOT_EMPTY,
          ),
        );
      }

      const { count } = await tx.stockItem.updateMany({
        where: { ...where, quantity: { gte: request.quantity } },
        data: { quantity: { decrement: request.quantity } },
      });
      if (count === 0) {
        this.logger.warn(
          `Reddedildi: createStockSale stok yetersiz (itemId=${request.itemId} quantity=${request.quantity})`,
        );
        throw new RpcException(
          getValidationMessage(DtoPrefix.QUANTITY, ValidationType.MIN, 0),
        );
      }

      const sale = await tx.stockSale.create({
        data: {
          clinicId: request.clinicId,
          stockItemId: item.id,
          itemName: item.name,
          category: item.category,
          unit: item.unit,
          quantity: request.quantity,
          unitSalePrice: request.unitPrice ?? item.salePrice,
          unitPurchasePrice: item.purchasePrice,
          createdBy: user.userId,
        },
      });
      const updated = await tx.stockItem.findUniqueOrThrow({
        where: { id: item.id },
      });
      return {
        sale: ClinicsService.toProtoSale(sale),
        item: ClinicsService.toProtoStockItem(updated),
      };
    });
  }

  async cancelStockSale(
    request: clinics.CancelStockSaleRequest,
    user: AuthUser,
  ): Promise<clinics.StockSaleResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'cancelStockSale');

    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.stockSale.findFirst({
        where: { id: request.saleId, clinicId: request.clinicId },
      });
      if (!sale) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `cancelStockSale: satış bulunamadı (saleId=${request.saleId})`,
        );
      }
      if (sale.cancelledAt) {
        rejectRpc(
          this.logger,
          ResponseMessages.CONFLICT,
          `cancelStockSale: satış zaten iptal edilmiş (saleId=${sale.id})`,
        );
      }
      if (businessMonth(sale.soldAt) !== businessMonth(new Date())) {
        rejectRpc(
          this.logger,
          ResponseMessages.CONFLICT,
          `cancelStockSale: satış yalnızca yapıldığı ay içinde iptal edilebilir (saleId=${sale.id})`,
        );
      }

      const { count } = await tx.stockSale.updateMany({
        where: { id: sale.id, cancelledAt: null },
        data: { cancelledAt: new Date() },
      });
      if (count === 0) {
        rejectRpc(
          this.logger,
          ResponseMessages.CONFLICT,
          `cancelStockSale: satış eşzamanlı olarak iptal edildi (saleId=${sale.id})`,
        );
      }

      let item: StockItem | null = null;
      if (sale.stockItemId) {
        const restored = await tx.stockItem.updateMany({
          where: {
            id: sale.stockItemId,
            quantity: { lte: STOCK_AMOUNT_MAX - sale.quantity },
          },
          data: { quantity: { increment: sale.quantity } },
        });
        item = await tx.stockItem.findUnique({
          where: { id: sale.stockItemId },
        });
        if (restored.count === 0 && item) {
          this.logger.warn(
            `Reddedildi: cancelStockSale stoku üst sınırın üstüne çıkarırdı (saleId=${sale.id})`,
          );
          throw new RpcException(
            getValidationMessage(
              DtoPrefix.QUANTITY,
              ValidationType.MAX,
              STOCK_AMOUNT_MAX,
            ),
          );
        }
      }

      const cancelled = await tx.stockSale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      return {
        sale: ClinicsService.toProtoSale(cancelled),
        item: item ? ClinicsService.toProtoStockItem(item) : undefined,
      };
    });
  }

  async listStockSales(
    request: clinics.ListStockSalesRequest,
    user: AuthUser,
  ): Promise<clinics.ListStockSalesResponse> {
    await this.assertActiveOwnClinic(request.clinicId, user, 'listStockSales');

    const where: Prisma.StockSaleWhereInput = {
      clinicId: request.clinicId,
      ...(request.fromDate || request.toDate
        ? {
            soldAt: {
              ...(request.fromDate
                ? { gte: zonedMidnightToUtc(request.fromDate) }
                : {}),
              ...(request.toDate
                ? { lt: zonedMidnightToUtc(addDays(request.toDate, 1)) }
                : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockSale.findMany({
        where,
        orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.stockSale.count({ where }),
    ]);

    return {
      sales: rows.map((row) => ClinicsService.toProtoSale(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async getStockSalesSummary(
    request: clinics.GetStockSalesSummaryRequest,
    user: AuthUser,
  ): Promise<clinics.StockSalesSummaryResponse> {
    await this.assertActiveOwnClinic(
      request.clinicId,
      user,
      'getStockSalesSummary',
    );

    const month = request.month || todayInBusinessTimeZone().slice(0, 7);
    const from = zonedMidnightToUtc(`${month}-01`).toISOString();
    const to = zonedMidnightToUtc(`${nextMonth(month)}-01`).toISOString();

    const [dailyRows, productRows] = await Promise.all([
      this.prisma.$queryRaw<DailySalesRow[]>`
        SELECT to_char((s.sold_at AT TIME ZONE 'UTC') AT TIME ZONE ${BUSINESS_TIME_ZONE}, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS "salesCount",
               SUM(s.quantity)::bigint AS quantity,
               SUM(s.quantity::bigint * s.unit_sale_price)::bigint AS revenue,
               SUM(s.quantity::bigint * s.unit_purchase_price)::bigint AS cost
        FROM stock_sales s
        WHERE s.clinic_id = ${request.clinicId}::uuid
          AND s.cancelled_at IS NULL
          AND s.sold_at >= (${from}::timestamptz AT TIME ZONE 'UTC')
          AND s.sold_at < (${to}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY day
        ORDER BY day`,
      this.prisma.$queryRaw<ProductSalesRow[]>`
        SELECT s.stock_item_id AS "stockItemId",
               (array_agg(s.item_name ORDER BY s.sold_at DESC))[1] AS "itemName",
               (array_agg(s.unit::text ORDER BY s.sold_at DESC))[1] AS unit,
               COUNT(*)::int AS "salesCount",
               SUM(s.quantity)::bigint AS quantity,
               SUM(s.quantity::bigint * s.unit_sale_price)::bigint AS revenue,
               SUM(s.quantity::bigint * s.unit_purchase_price)::bigint AS cost
        FROM stock_sales s
        WHERE s.clinic_id = ${request.clinicId}::uuid
          AND s.cancelled_at IS NULL
          AND s.sold_at >= (${from}::timestamptz AT TIME ZONE 'UTC')
          AND s.sold_at < (${to}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY s.stock_item_id, CASE WHEN s.stock_item_id IS NULL THEN s.item_name END
        ORDER BY revenue DESC, "itemName"`,
    ]);

    const byDay = new Map(dailyRows.map((row) => [row.day, row]));
    const daily = monthDays(month).map((date) => ({
      date,
      ...ClinicsService.toFigures(byDay.get(date)),
    }));
    const figuresOf = new Map(daily.map((day) => [day.date, day]));
    const weekly = monthWeeks(month).map((week) => ({
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      ...ClinicsService.sumFigures(
        week.days.map((date) => figuresOf.get(date) as SalesFigures),
      ),
    }));

    return {
      month,
      totals: ClinicsService.sumFigures(daily),
      daily,
      weekly,
      products: productRows.map((row) => ({
        stockItemId: row.stockItemId ?? '',
        itemName: row.itemName,
        unit: row.unit,
        ...ClinicsService.toFigures(row),
      })),
    };
  }

  private rejectIfStockItemMissing(
    e: unknown,
    itemId: string,
    method_name: string,
  ): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2025'
    ) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: stok kalemi bulunamadı (itemId=${itemId})`,
      );
    }
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
    await this.assertActiveOwnClinic(request.clinicId, user, 'uploadPetResult');

    let response: medicalRecord.DocumentResponse;
    try {
      response = await firstValueFrom(
        this.medicalRecordClient.registerDocument({
          petId: request.petId,
          storagePath: request.storagePath,
          originalName: request.originalName,
          mimeType: request.mimeType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          note: request.note ?? '',
        }),
      );
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === status.DEADLINE_EXCEEDED) {
        this.logger.error(
          `uploadPetResult: medical_record.registerDocument zaman aşımına uğradı, belge kaydı oluşmuş olabilir (clinicId=${request.clinicId} storagePath=${request.storagePath})`,
        );
      }
      forwardGrpcError(
        this.logger,
        e,
        'uploadPetResult: medical_record.registerDocument',
        [ResponseMessages.FORBIDDEN, ResponseMessages.CONFLICT],
      );
    }

    if (!response.document) {
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `uploadPetResult: medical_record.registerDocument boş yanıt döndü (storagePath=${request.storagePath})`,
      );
    }

    return {
      documentId: response.document.id,
      uploadedAt: response.document.createdAt,
      status: medicalRecord.DocumentStatus[response.document.status] ?? '',
    };
  }

  //#endregion
}
