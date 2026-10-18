import {
  AuthUser,
  CLOUD_EVENT_SOURCES,
  ConsentScope,
  createCloudEvent,
  createGrpcValidationPipe,
  DOCUMENT_EVENT_TYPES,
  forwardGrpcError,
  getCorrelationId,
  rejectRpc,
  ResponseMessages,
} from '@libs/common';
import {
  CreateRecordRequestDto,
  RecordContentDto,
  ReviewDraftRequestDto,
  todayInBusinessTimeZone,
} from '@libs/dto';
import { access, events, medicalRecord, pets } from '@libs/proto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from './prisma/prisma.service';
import { DraftReviewStatus, Prisma } from '../generated/prisma/client';
import { CONSENT_PAGE_SIZE } from './medical-record.constants';
import {
  DOCUMENT_INCLUDE,
  DOCUMENT_STATUS_TO_DB,
  DocumentWithDraft,
  DRAFT_INCLUDE,
  DRAFT_STATUS_TO_DB,
  DraftWithDocument,
  fromDateOnly,
  LAB_RESULT_INCLUDE,
  PRESCRIPTION_INCLUDE,
  RECORD_INCLUDE,
  RECORD_TYPE_TO_DB,
  toProtoDocument,
  toProtoDraft,
  toProtoLabResult,
  toProtoPrescription,
  toProtoRecord,
  toProtoVaccination,
  toRecordContentData,
  VACCINATION_INCLUDE,
} from './medical-record.mapper';

@Injectable()
export class MedicalRecordService implements OnModuleInit {
  private readonly logger = new Logger(MedicalRecordService.name);
  private readonly contentValidation = createGrpcValidationPipe();
  private accessClient!: access.AccessServiceClient;
  private petsClient!: pets.PetsServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('ACCESS_SERVICE') private readonly access_client: ClientGrpc,
    @Inject('PETS_SERVICE') private readonly pets_client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.accessClient =
      this.access_client.getService<access.AccessServiceClient>(
        access.ACCESS_SERVICE_NAME,
      );
    this.petsClient = this.pets_client.getService<pets.PetsServiceClient>(
      pets.PETS_SERVICE_NAME,
    );
  }

  private async assertClinicScope(
    petId: string,
    user: AuthUser,
    scope: ConsentScope,
    method_name: string,
  ): Promise<void> {
    let consent: access.CheckAccessResponse;
    try {
      consent = await firstValueFrom(
        this.accessClient.checkAccess({
          clinicId: user.clinicId,
          petId,
          requiredScopes: [scope],
        }),
      );
    } catch (e) {
      forwardGrpcError(this.logger, e, `${method_name}: access.checkAccess`);
    }

    if (!consent.allowed) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `${method_name}: ${scope} izni yok (clinicId=${user.clinicId} petId=${petId})`,
        'log',
      );
    }
  }

  private async assertPetOwner(
    petId: string,
    user: AuthUser,
    method_name: string,
  ): Promise<void> {
    let owner: pets.GetPetOwnerResponse;
    try {
      owner = await firstValueFrom(this.petsClient.getPetOwner({ petId }));
    } catch (e) {
      forwardGrpcError(this.logger, e, `${method_name}: pets.getPetOwner`, [
        ResponseMessages.NOT_FOUND,
      ]);
    }

    if (owner.ownerUserId !== user.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: pet kullanıcıya ait değil (userId=${user.userId} petId=${petId})`,
        'warn',
      );
    }
  }

  private async assertPetReadable(
    petId: string,
    user: AuthUser,
    scope: ConsentScope,
    method_name: string,
  ): Promise<void> {
    if (user.role === 'PET_OWNER') {
      await this.assertPetOwner(petId, user, method_name);
      return;
    }
    await this.assertClinicScope(petId, user, scope, method_name);
  }

  private async getConsentedPetIds(
    scope: ConsentScope,
    method_name: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      let res: access.ListMyConsentsResponse;
      try {
        res = await firstValueFrom(
          this.accessClient.listMyConsents({
            page,
            pageSize: CONSENT_PAGE_SIZE,
          }),
        );
      } catch (e) {
        forwardGrpcError(
          this.logger,
          e,
          `${method_name}: access.listMyConsents`,
        );
      }
      ids.push(
        ...res.consents
          .filter(
            (consent) =>
              consent.status === access.ConsentStatus.ACTIVE &&
              consent.scopes.includes(scope),
          )
          .map((consent) => consent.petId),
      );
      if (page * CONSENT_PAGE_SIZE >= res.total) return ids;
    }
  }

  private async findOwnDraft(
    id: string,
    user: AuthUser,
    method_name: string,
  ): Promise<DraftWithDocument> {
    const draft = await this.prisma.draftReview.findUnique({
      where: { id },
      include: DRAFT_INCLUDE,
    });

    if (!draft || draft.clinicId !== user.clinicId) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: taslak yok ya da kliniğe ait değil (clinicId=${user.clinicId} draftReviewId=${id})`,
        draft ? 'warn' : undefined,
      );
    }
    return draft;
  }

  private rejectDraftConflict(draftId: string, method_name: string): never {
    rejectRpc(
      this.logger,
      ResponseMessages.CONFLICT,
      `${method_name}: taslak zaten incelenmiş (draftReviewId=${draftId})`,
      'warn',
    );
  }

  private validateContent(content: unknown): Promise<RecordContentDto> {
    return this.contentValidation.transform(content, {
      type: 'body',
      metatype: RecordContentDto,
    });
  }

  private static uniqueConstraintName(
    e: Prisma.PrismaClientKnownRequestError,
  ): string | undefined {
    const meta = e.meta as
      | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
      | undefined;
    return meta?.driverAdapterError?.cause?.constraint?.index;
  }

  private rejectDocumentConflict(e: unknown, method_name: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const constraint = MedicalRecordService.uniqueConstraintName(e);

      if (constraint === 'documents_storage_path_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.CONFLICT,
          `${method_name}: storage_path zaten kayıtlı`,
          'warn',
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

  async registerDocument(
    request: medicalRecord.RegisterDocumentRequest,
    user: AuthUser,
  ): Promise<medicalRecord.DocumentResponse> {
    await this.assertClinicScope(
      request.petId,
      user,
      'medical_write',
      'registerDocument',
    );

    let document: DocumentWithDraft;
    try {
      document = await this.prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: {
            petId: request.petId,
            clinicId: user.clinicId,
            storagePath: request.storagePath,
            originalName: request.originalName,
            mimeType: request.mimeType,
            sizeBytes: request.sizeBytes,
            sha256: request.sha256,
            note: request.note || null,
          },
          include: DOCUMENT_INCLUDE,
        });

        const data: events.DocumentUploaded = {
          documentId: created.id,
          petId: created.petId,
          clinicId: created.clinicId,
          storagePath: created.storagePath,
          mimeType: created.mimeType,
          sizeBytes: created.sizeBytes,
          sha256: created.sha256,
        };
        const event = createCloudEvent({
          type: DOCUMENT_EVENT_TYPES.UPLOADED,
          source: CLOUD_EVENT_SOURCES.MEDICAL_RECORD,
          subject: created.id,
          data,
        });

        await tx.outbox.create({
          data: {
            id: event.id,
            type: event.type,
            payload: event as unknown as Prisma.InputJsonObject,
            correlationId: getCorrelationId(),
          },
        });

        return created;
      });
    } catch (e) {
      this.rejectDocumentConflict(e, 'registerDocument');
    }

    return { document: toProtoDocument(document) };
  }

  async getDocument(
    request: medicalRecord.GetDocumentRequest,
    user: AuthUser,
  ): Promise<medicalRecord.DocumentResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: request.id },
      include: DOCUMENT_INCLUDE,
    });

    if (
      !document ||
      (user.role !== 'PET_OWNER' && document.clinicId !== user.clinicId)
    ) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getDocument: belge yok ya da kliniğe ait değil (clinicId=${user.clinicId} documentId=${request.id})`,
        document ? 'warn' : undefined,
      );
    }

    await this.assertPetReadable(
      document.petId,
      user,
      'medical_write',
      'getDocument',
    );

    return { document: toProtoDocument(document) };
  }

  async listDocumentsByPet(
    request: medicalRecord.ListDocumentsByPetRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListDocumentsResponse> {
    await this.assertPetReadable(
      request.petId,
      user,
      'medical_write',
      'listDocumentsByPet',
    );

    const status =
      request.status !== undefined
        ? DOCUMENT_STATUS_TO_DB[request.status]
        : undefined;

    const where: Prisma.DocumentWhereInput = {
      petId: request.petId,
      ...(user.role === 'PET_OWNER' ? {} : { clinicId: user.clinicId }),
      ...(status ? { status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        include: DOCUMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      documents: rows.map((row) => toProtoDocument(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async createRecord(
    request: CreateRecordRequestDto,
    user: AuthUser,
  ): Promise<medicalRecord.RecordResponse> {
    await this.assertClinicScope(
      request.petId,
      user,
      'medical_write',
      'createRecord',
    );

    const documentIds = (request.attachments ?? []).map(
      (attachment) => attachment.documentId,
    );

    if (documentIds.length > 0) {
      const found = await this.prisma.document.count({
        where: {
          id: { in: documentIds },
          petId: request.petId,
          clinicId: user.clinicId,
        },
      });

      if (found !== documentIds.length) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `createRecord: ek belgelerden en az biri yok ya da bu hayvana/kliniğe ait değil (clinicId=${user.clinicId} petId=${request.petId})`,
          'warn',
        );
      }
    }

    const record = await this.prisma.medicalRecord.create({
      data: {
        ...toRecordContentData(request.content),
        petId: request.petId,
        clinicId: user.clinicId,
        attachments: {
          create: documentIds.map((documentId) => ({ documentId })),
        },
      },
      include: RECORD_INCLUDE,
    });

    return { record: toProtoRecord(record) };
  }

  async listRecordsByPet(
    request: medicalRecord.ListRecordsByPetRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListRecordsResponse> {
    await this.assertPetReadable(
      request.petId,
      user,
      'medical_read',
      'listRecordsByPet',
    );

    const recordType =
      request.type !== undefined ? RECORD_TYPE_TO_DB[request.type] : undefined;

    const where: Prisma.MedicalRecordWhereInput = {
      petId: request.petId,
      ...(recordType ? { type: recordType } : {}),
      ...(request.fromDate || request.toDate
        ? {
            recordedAt: {
              ...(request.fromDate
                ? { gte: fromDateOnly(request.fromDate) }
                : {}),
              ...(request.toDate ? { lte: fromDateOnly(request.toDate) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.medicalRecord.findMany({
        where,
        include: RECORD_INCLUDE,
        orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.medicalRecord.count({ where }),
    ]);

    return {
      records: rows.map((row) => toProtoRecord(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async listVaccinations(
    request: medicalRecord.ListVaccinationsRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListVaccinationsResponse> {
    await this.assertPetReadable(
      request.petId,
      user,
      'vaccination_read',
      'listVaccinations',
    );

    const where: Prisma.VaccinationWhereInput = {
      record: { petId: request.petId },
      ...(request.onlyUpcoming
        ? { nextDueAt: { gte: fromDateOnly(todayInBusinessTimeZone()) } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vaccination.findMany({
        where,
        include: VACCINATION_INCLUDE,
        orderBy: request.onlyUpcoming
          ? [{ nextDueAt: 'asc' }, { id: 'asc' }]
          : [{ administeredAt: 'desc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.vaccination.count({ where }),
    ]);

    return {
      vaccinations: rows.map((row) => toProtoVaccination(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async listPrescriptions(
    request: medicalRecord.ListPrescriptionsRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListPrescriptionsResponse> {
    await this.assertPetReadable(
      request.petId,
      user,
      'prescription_read',
      'listPrescriptions',
    );

    const activeFilter = request.onlyActive
      ? Prisma.sql`AND p.prescribed_at + p.duration_days - 1 >= ${todayInBusinessTimeZone()}::date`
      : Prisma.empty;

    const [idRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id
        FROM prescriptions p
        JOIN medical_records r ON r.id = p.record_id
        WHERE r.pet_id = ${request.petId}::uuid ${activeFilter}
        ORDER BY p.prescribed_at DESC, p.id ASC
        LIMIT ${request.pageSize} OFFSET ${(request.page - 1) * request.pageSize}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total
        FROM prescriptions p
        JOIN medical_records r ON r.id = p.record_id
        WHERE r.pet_id = ${request.petId}::uuid ${activeFilter}`,
    ]);

    const ids = idRows.map((row) => row.id);
    const rows =
      ids.length > 0
        ? await this.prisma.prescription.findMany({
            where: { id: { in: ids } },
            include: PRESCRIPTION_INCLUDE,
          })
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      prescriptions: ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toProtoPrescription(row)] : [];
      }),
      total: countRows[0]?.total ?? 0,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async listLabResults(
    request: medicalRecord.ListLabResultsRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListLabResultsResponse> {
    await this.assertPetReadable(
      request.petId,
      user,
      'medical_read',
      'listLabResults',
    );

    const where: Prisma.LabResultWhereInput = {
      record: { petId: request.petId },
      ...(request.testName
        ? { testName: { contains: request.testName, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.labResult.findMany({
        where,
        include: LAB_RESULT_INCLUDE,
        orderBy: [{ sampledAt: 'desc' }, { testName: 'asc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.labResult.count({ where }),
    ]);

    return {
      labResults: rows.map((row) => toProtoLabResult(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async listDraftReviews(
    request: medicalRecord.ListDraftReviewsRequest,
    user: AuthUser,
  ): Promise<medicalRecord.ListDraftReviewsResponse> {
    let petIds: string[];
    if (request.petId) {
      await this.assertClinicScope(
        request.petId,
        user,
        'medical_write',
        'listDraftReviews',
      );
      petIds = [request.petId];
    } else {
      petIds = await this.getConsentedPetIds(
        'medical_write',
        'listDraftReviews',
      );
    }

    if (petIds.length === 0) {
      return {
        draftReviews: [],
        total: 0,
        page: request.page,
        pageSize: request.pageSize,
      };
    }

    const status =
      request.status !== undefined
        ? DRAFT_STATUS_TO_DB[request.status]
        : undefined;

    const where: Prisma.DraftReviewWhereInput = {
      clinicId: user.clinicId,
      petId: { in: petIds },
      ...(status ? { status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.draftReview.findMany({
        where,
        include: DRAFT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.draftReview.count({ where }),
    ]);

    return {
      draftReviews: rows.map((row) => toProtoDraft(row)),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  async reviewDraft(
    request: ReviewDraftRequestDto,
    user: AuthUser,
  ): Promise<medicalRecord.DraftReviewResponse> {
    const draft = await this.findOwnDraft(request.id, user, 'reviewDraft');

    await this.assertClinicScope(
      draft.petId,
      user,
      'medical_write',
      'reviewDraft',
    );

    if (draft.status !== DraftReviewStatus.PENDING) {
      this.rejectDraftConflict(draft.id, 'reviewDraft');
    }

    const review = {
      reviewNote: request.reviewNote || null,
      reviewedByClinicId: user.clinicId,
      reviewedAt: new Date(),
    };

    if (!request.approved) {
      const rejected = await this.prisma.draftReview.updateMany({
        where: { id: draft.id, status: DraftReviewStatus.PENDING },
        data: { ...review, status: DraftReviewStatus.REJECTED },
      });

      if (rejected.count === 0) {
        this.rejectDraftConflict(draft.id, 'reviewDraft');
      }
    } else {
      const content = await this.validateContent(
        request.editedContent ?? draft.proposedPayload,
      );

      await this.prisma.$transaction(async (tx) => {
        const approved = await tx.draftReview.updateMany({
          where: { id: draft.id, status: DraftReviewStatus.PENDING },
          data: {
            ...review,
            status: DraftReviewStatus.APPROVED,
            ...(request.editedContent
              ? {
                  approvedPayload: JSON.parse(
                    JSON.stringify(content),
                  ) as Prisma.InputJsonObject,
                }
              : {}),
          },
        });

        if (approved.count === 0) {
          this.rejectDraftConflict(draft.id, 'reviewDraft');
        }

        const record = await tx.medicalRecord.create({
          data: {
            ...toRecordContentData(content),
            petId: draft.petId,
            clinicId: draft.clinicId,
            sourceDocumentId: draft.documentId,
            sourceDraftReviewId: draft.id,
            attachments: { create: [{ documentId: draft.documentId }] },
          },
          select: { id: true },
        });

        await tx.draftReview.update({
          where: { id: draft.id },
          data: { createdRecordId: record.id },
        });
      });
    }

    const reviewed = await this.prisma.draftReview.findUniqueOrThrow({
      where: { id: draft.id },
      include: DRAFT_INCLUDE,
    });

    return { draftReview: toProtoDraft(reviewed) };
  }
}
