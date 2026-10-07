import { access, clinics, pets } from '@libs/proto';
import { Inject, Injectable } from '@nestjs/common';
import { OpaqueTokenRecord, RedisService } from './redis/redis.service';
import {
  AuthUser,
  ConsentScope,
  forwardGrpcError,
  getCorrelationId,
  rejectRpc,
  ResponseMessages,
  TOKEN_ROLES,
  TokenRole,
} from '@libs/common';
import { isUUID } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import {
  ACCESS_JWT_TTL_SECONDS,
  CONSENT_MAX_DURATION_YEARS,
} from './access.constants';
import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  Consent,
  ConsentStatus as DbConsentStatus,
  Prisma,
} from '../generated/prisma/client';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

interface ConsentEvaluationResult {
  isAllowed: boolean;
  status: access.ConsentStatus;
  deniedReason: access.DeniedReason;
}

const SCOPE_COLUMNS = {
  medical_read: 'medicalRead',
  medical_write: 'medicalWrite',
  vaccination_read: 'vaccinationRead',
  prescription_read: 'prescriptionRead',
  chip_number_read: 'chipNumberRead',
  owner_contact_read: 'ownerContactRead',
} as const satisfies Record<ConsentScope, keyof Consent>;

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private petsClient!: pets.PetsServiceClient;
  private clinicClient!: clinics.ClinicsServiceClient;
  constructor(
    @Inject('PETS_SERVICE') private readonly pets_client: ClientGrpc,
    @Inject('CLINIC_SERVİCE') private readonly clinic_Client: ClientGrpc,
    private readonly redis: RedisService,
    private readonly accessJwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.petsClient = this.pets_client.getService<pets.PetsServiceClient>(
      pets.PETS_SERVICE_NAME,
    );

    this.clinicClient =
      this.clinic_Client.getService<clinics.ClinicsServiceClient>(
        clinics.CLINICS_SERVICE_NAME,
      );
  }

  //#region ------------sadece access service methodları çağırıcak-------------

  // - Amaç: opaque token'ı üretmek -
  private generateOpaqueToken(): string {
    this.logger.debug('generateOpaqueToken metodunda Opaque token üretildi');
    return randomBytes(32).toString('base64url');
  }

  // - Amaç: opaque token'ı kısa ömürlü(1 dk) JWT ye çeviricek ana fonksiyon -
  private async introspectOpaqueToken(
    opaqueToken: string,
    clientType: access.ClientType,
  ): Promise<OpaqueTokenRecord> {
    const record = await this.redis.getTokenRecord(opaqueToken);

    if (!record) {
      rejectRpc(
        this.logger,
        ResponseMessages.INVALID_TOKEN,
        'introspectOpaqueToken metodunda redisten dönen record bulunamadı',
      );
    }

    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.redis.deleteTokenRecord(opaqueToken);
      rejectRpc(
        this.logger,
        ResponseMessages.TOKEN_EXPIRED,
        'introspectOpaqueToken metodunda record un tarihi geçmiş',
      );
    }

    // proto: "Web'den çalınan token mobilde işe yaramaz"
    if (record.clientType !== clientType) {
      rejectRpc(
        this.logger,
        ResponseMessages.INVALID_TOKEN,
        `clientType uyuşmazlığı (beklenen=${record.clientType} gelen=${clientType})`,
        'warn',
      );
    }

    return record;
  }

  // - Amaç: kullanıcı bilgisini opaque token oluşturup redis'e kayıt işlemini tetikler -
  private async registerUserToken(
    dto: access.CreateTokenRequest,
  ): Promise<access.CreateTokenResponse> {
    this.logger.debug('istek registerUserToken metoduna geldi');
    const opaqueToken = this.generateOpaqueToken();

    this.logger.debug(
      'registerUserToken: access-redis(createTokenRecord) istek atıldı',
    );
    const created = await this.redis.createTokenRecord(
      opaqueToken,
      {
        userId: dto.userId,
        role: dto.role,
        clinicId: dto.clinicId,
        clientType: dto.clientType,
      },
      dto.ttlSeconds === 0 ? undefined : dto.ttlSeconds,
    );

    this.logger.debug('registerUserToken: başarıyla tamamlandı');
    return {
      opaqueToken,
      expiresIn: created.ttlSeconds,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
    };
  }

  // - Amaç: DB rıza statüsünü zaman kontrolü (expiresAt) yaparak güncel gRPC statüsüne çeviren fonksiyon. -
  private toReverseConsentStatus(
    status: DbConsentStatus,
    expiresAt: Date,
  ): access.ConsentStatus {
    switch (status) {
      case DbConsentStatus.REVOKED:
        return access.ConsentStatus.REVOKED;
      case DbConsentStatus.ACTIVE:
        return expiresAt.getTime() <= Date.now()
          ? access.ConsentStatus.EXPIRED
          : access.ConsentStatus.ACTIVE;
    }
  }

  // - Amaç: Rıza durumunu ve eksik yetkileri (scope) değerlendirip işlem iznini ve ret sebebini hesaplayan fonksiyon. -
  private evaluateConsent(
    consent: Consent,
    missingScopes: string[],
  ): ConsentEvaluationResult {
    const status = this.toReverseConsentStatus(
      consent.status,
      consent.expiresAt,
    );

    if (status !== access.ConsentStatus.ACTIVE) {
      return {
        isAllowed: false,
        status,
        deniedReason:
          status === access.ConsentStatus.REVOKED
            ? access.DeniedReason.DENIED_REASON_REVOKED
            : access.DeniedReason.DENIED_REASON_EXPIRED,
      };
    }

    if (missingScopes.length > 0) {
      return {
        isAllowed: false,
        status,
        deniedReason: access.DeniedReason.DENIED_REASON_INSUFFICIENT_SCOPE,
      };
    }

    return {
      isAllowed: true,
      status,
      deniedReason: access.DeniedReason.DENIED_REASON_UNSPECIFIED,
    };
  }

  // - Amaç: Client'tan gelen dizisini Prisma'nın beklediği objesine çevirir. -
  private mapScopesToBooleans(scopes: string[]): Partial<Consent> {
    return (Object.entries(SCOPE_COLUMNS) as [ConsentScope, string][]).reduce(
      (acc, [scope, column]) => {
        acc[column] = scopes.includes(scope);
        return acc;
      },
      {} as Record<string, boolean>,
    ) as Partial<Consent>;
  }

  // - Amaç: Veritabanındaki boolean alanları okuyup, gRPC response'u için tekrar dizisine geri çevirir. -
  private mapBooleansToScopes(consent: Consent): string[] {
    return (Object.entries(SCOPE_COLUMNS) as [ConsentScope, keyof Consent][])
      .filter(([, column]) => consent[column])
      .map(([scope]) => scope);
  }

  private toConsentResponse(consent: Consent): access.ConsentResponse {
    return {
      consentId: consent.id,
      status: this.toReverseConsentStatus(consent.status, consent.expiresAt),
      ownerUserId: consent.petOwnerId,
      clinicId: consent.clinicId,
      petId: consent.petId,
      scopes: this.mapBooleansToScopes(consent),
      grantedAt: consent.createdAt.toISOString(),
      expiresAt: consent.expiresAt.toISOString(),
      revokedAt: consent.revokedAt ? consent.revokedAt.toISOString() : '',
    };
  }

  private async checkPetOwner(
    payload: {
      petId: string;
      userId: string;
    },
    method_name: string,
  ): Promise<void> {
    let pet_owner_res: pets.GetPetOwnerResponse;
    try {
      this.logger.debug(
        `${method_name}: pet servisine(getPetOwner) istek atıldı`,
      );
      pet_owner_res = await firstValueFrom(
        this.petsClient.getPetOwner({
          petId: payload.petId,
        }),
      );
    } catch (e) {
      forwardGrpcError(this.logger, e, `${method_name}: pets.getPetOwner`, [
        ResponseMessages.NOT_FOUND,
      ]);
    }

    if (!pet_owner_res?.ownerUserId || pet_owner_res.petId !== payload.petId) {
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `${method_name}: pets.getPetOwner eksik veya tutarsız yanıt döndü (petId=${payload.petId})`,
      );
    }

    if (pet_owner_res.ownerUserId !== payload.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: IDOR girişimi, pet kullanıcıya ait değil (userId=${payload.userId} petId=${payload.petId})`,
        'warn',
      );
    }
  }

  private async checkClinic(
    payload: {
      clinicId: string;
    },
    method_name: string,
  ): Promise<void> {
    let clinic_res: clinics.ClinicResponse;
    try {
      this.logger.debug(
        `${method_name}: clinic servisine(getClinic) istek atıldı`,
      );
      clinic_res = await firstValueFrom(
        this.clinicClient.getClinic({
          id: payload.clinicId,
        }),
      );
    } catch (e) {
      forwardGrpcError(this.logger, e, `${method_name}: clinics.getClinic`, [
        ResponseMessages.NOT_FOUND,
      ]);
    }

    const clinic = clinic_res?.clinic;
    if (!clinic || clinic.id !== payload.clinicId) {
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `${method_name}: clinics.getClinic eksik veya tutarsız yanıt döndü (clinicId=${payload.clinicId})`,
      );
    }

    if (!clinic.isActive) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `${method_name}: klinik pasif (clinicId=${payload.clinicId})`,
      );
    }
  }

  //#endregion

  // ------------sadece gateway çağırıcak-------------

  // ---Amaç: opaque token'ı kısa ömürlü(1 dk) JWT ye çeviricek ---
  async exchangeToken(
    request: access.ExchangeTokenRequest,
  ): Promise<access.ExchangeTokenResponse> {
    this.logger.debug('istek exchangeToken metoduna geldi');
    const record = await this.introspectOpaqueToken(
      request.opaqueToken,
      request.clientType,
    );

    this.logger.debug('exchangeToken: opaque -> jwt dönüşümü başladı');
    const jwt = this.accessJwt.sign({
      sub: record.userId,
      role: record.role,
      clinicId: record.clinicId,
      clientType: record.clientType,
    });

    this.logger.debug('exchangeToken: başarıyla tamamlandı');
    return {
      jwt,
      expiresIn: ACCESS_JWT_TTL_SECONDS,
      traceId: getCorrelationId(),
      userId: record.userId,
      role: record.role,
      clinicId: record.clinicId,
      clientType: record.clientType,
    };
  }

  // ------------sadece auth servisi çarabilecek-------------

  // --- Amaç: Opaque token oluşumu ve redis'e kayıt ---
  async createOpaqueToken(
    request: access.CreateTokenRequest,
  ): Promise<access.CreateTokenResponse> {
    this.logger.debug('istek createOpaqueToken metoduna geldi');
    if (request.ttlSeconds < 0) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'ttlSeconds negatif',
      );
    }

    if (
      request.clientType === access.ClientType.CLIENT_TYPE_UNSPECIFIED ||
      request.clientType === access.ClientType.UNRECOGNIZED
    ) {
      rejectRpc(
        this.logger,
        ResponseMessages.INVALID_CLIENT_TYPE,
        'clientType geçersiz',
      );
    }

    if (!isUUID(request.userId, '4')) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'userId UUID v4 değil',
      );
    }

    if (!TOKEN_ROLES.includes(request.role as TokenRole)) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'role beyaz listede değil',
      );
    }

    const isPetOwner = request.role === 'PET_OWNER';
    const hasClinic = !!request.clinicId?.trim();
    if (isPetOwner && hasClinic) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'PET_OWNER kliniğe bağlı olamaz',
      );
    }
    if (!isPetOwner && !hasClinic) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'klinik hesabı için clinicId zorunlu',
      );
    }
    if (hasClinic && !isUUID(request.clinicId, '4')) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'clinicId UUID v4 değil',
      );
    }
    this.logger.debug(
      'createOpaqueToken: registerUserToken metoduna istek yollandı',
    );
    return this.registerUserToken({
      ...request,
    });
  }

  // --- Amaç: Opaque tokenı redis'den silme ---
  async revokeToken(
    data: access.RevokeTokenRequest,
  ): Promise<access.RevokeTokenResponse> {
    this.logger.debug('istek revokeToken metoduna geldi');
    if (!data.opaqueToken || data.opaqueToken.trim() === '') {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'deleteOpaqueToken: opaqueToken doğru formatta değil veya boş',
      );
    }

    try {
      this.logger.debug(
        'revokeToken: access-redis(deleteTokenRecord) istek yollandı',
      );
      const deletedCount = await this.redis.deleteTokenRecord(data.opaqueToken);

      if (deletedCount === false) {
        this.logger.warn(
          `deleteOpaqueToken: kayıt bulunamadı, silinecek bir şey yok.`,
        );
        return { revoked: false };
      }

      this.logger.debug('revokeToken: başarıyla tamamlandı');
      return { revoked: true };
    } catch (error) {
      this.logger.debug('revokeToken: hata oluştu ve catch bloğuna girildi');
      this.logger.error(
        `deleteOpaqueToken: Redis silme işleminde kritik hata `,
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }

  // -------------- Sadece alt servisler rıza kontrolü için çağırır -------------

  // --- Amaç: rıza kontrolü ---
  async checkAccess(
    request: access.CheckAccessRequest,
    user: AuthUser,
  ): Promise<access.CheckAccessResponse> {
    this.logger.debug('istek checkAccess metoduna geldi');
    if (request.clinicId !== user.clinicId) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `checkAccess: clinicId uyuşmazlığı (token=${user.clinicId} istek=${request.clinicId})`,
        'warn',
      );
    }

    this.logger.debug('checkAccess: consent schemasına istek atıldı');
    const consent_res = await this.prisma.consent.findUnique({
      where: {
        clinicId_petId: { clinicId: request.clinicId, petId: request.petId },
      },
    });

    if (!consent_res) {
      return {
        allowed: false,
        grantedScopes: [],
        missingScopes: [],
        consentId: '',
        status: access.ConsentStatus.NOT_FOUND,
        expiresAt: '',
        deniedReason: access.DeniedReason.DENIED_REASON_NO_CONSENT,
      };
    }

    const { granted, missing } = request.requiredScopes.reduce(
      (acc, scope) => {
        const column = SCOPE_COLUMNS[scope as ConsentScope];
        (column && consent_res[column] ? acc.granted : acc.missing).push(scope);
        return acc;
      },
      { granted: [] as string[], missing: [] as string[] },
    );

    const evaluation = this.evaluateConsent(consent_res, missing);

    this.logger.debug('checkAccess: başarıyla tamamlandı');
    return {
      allowed: evaluation.isAllowed,
      grantedScopes:
        evaluation.status === access.ConsentStatus.ACTIVE ? granted : [],
      missingScopes: missing,
      consentId: consent_res.id,
      status: evaluation.status,
      expiresAt: consent_res.expiresAt.toISOString(),
      deniedReason: evaluation.deniedReason,
    };
  }

  async grantConsent(
    request: access.GrantConsentRequest,
    user: AuthUser,
  ): Promise<access.ConsentResponse> {
    this.logger.debug('istek grantConsent metoduna geldi');

    if (new Date(request.expiresAt).getTime() <= Date.now()) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'grantConsent: expiresAt geçmişte',
      );
    }

    const maxExpiresAt = new Date();
    maxExpiresAt.setUTCFullYear(
      maxExpiresAt.getUTCFullYear() + CONSENT_MAX_DURATION_YEARS,
    );
    if (new Date(request.expiresAt).getTime() > maxExpiresAt.getTime()) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        `grantConsent: expiresAt en fazla ${CONSENT_MAX_DURATION_YEARS} yıl sonrası olabilir`,
      );
    }

    await this.checkPetOwner(
      { petId: request.petId, userId: user.userId },
      'grantConsent',
    );

    await this.checkClinic({ clinicId: request.clinicId }, 'grantConsent');

    const scopeData = this.mapScopesToBooleans(request.scopes);

    this.logger.debug('grantConsent: $transaction işlemi başlıyor');
    const consest: Consent = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.actor_id', ${user.userId}, true)`;

      this.logger.debug('grantConsent: upsert işlemi başladı');
      const res = await tx.consent.upsert({
        where: {
          clinicId_petId: {
            clinicId: request.clinicId,
            petId: request.petId,
          },
        },
        update: {
          ...scopeData,
          expiresAt: new Date(request.expiresAt),
          status: DbConsentStatus.ACTIVE,
          revokedAt: null,
          petOwnerId: user.userId,
        },
        create: {
          ...scopeData,
          clinicId: request.clinicId,
          petId: request.petId,
          petOwnerId: user.userId,
          status: DbConsentStatus.ACTIVE,
          expiresAt: new Date(request.expiresAt),
        },
      });

      this.logger.debug('grantConsent: $transaction işlemi tamamlandı');
      return res;
    });

    this.logger.debug('grantConsent: başarıyla tamamlandı');
    return this.toConsentResponse(consest);
  }

  async revokeConsent(
    request: access.RevokeConsentRequest,
    user: AuthUser,
  ): Promise<access.ConsentResponse> {
    this.logger.debug('istek revokeConsent metoduna geldi');

    this.logger.debug('revokeConsent: $transaction işlemi başlıyor');
    const consent_res: Consent = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.actor_id', ${user.userId}, true)`;

      this.logger.debug('revokeConsent: update işlemi başladı');
      try {
        const res: Consent = await tx.consent.update({
          where: {
            id: request.consentId,
            petOwnerId: user.userId,
            status: DbConsentStatus.ACTIVE,
          },

          data: {
            status: DbConsentStatus.REVOKED,
            revokedAt: new Date(),
          },
        });

        this.logger.debug('revokeConsent: $transaction işlemi tamamlandı');
        return res;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          rejectRpc(
            this.logger,
            ResponseMessages.NOT_FOUND,
            'revokeConsent: satır bulunamadı',
          );
        }
        throw e;
      }
    });

    return this.toConsentResponse(consent_res);
  }

  async getConsentStatus(
    request: access.GetConsentStatusRequest,
    user: AuthUser,
  ): Promise<access.ConsentResponse> {
    this.logger.debug('istek getConsentStatus metoduna geldi');

    await this.checkPetOwner(
      { petId: request.petId, userId: user.userId },
      'getConsentStatus',
    );

    const consent_res = await this.prisma.consent.findUnique({
      where: {
        clinicId_petId: {
          clinicId: request.clinicId,
          petId: request.petId,
        },
      },
    });

    if (!consent_res) {
      return {
        consentId: '',
        status: access.ConsentStatus.NOT_FOUND,
        ownerUserId: '',
        clinicId: '',
        petId: '',
        scopes: [],
        grantedAt: '',
        expiresAt: '',
        revokedAt: '',
      };
    }

    this.logger.debug('getConsentStatus: başarıyla tamamlandı');
    return this.toConsentResponse(consent_res);
  }

  async listMyConsents(
    request: access.ListMyConsentsRequest,
    user: AuthUser,
  ): Promise<access.ListMyConsentsResponse> {
    this.logger.debug('istek listMyConsents metoduna geldi');

    let where: Prisma.ConsentWhereInput;
    if (user.role === 'CLINIC') {
      this.logger.debug('listMyConsents: klinik rızaları listeleniyor');
      where = {
        clinicId: user.clinicId,
        status: DbConsentStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      };
    } else {
      this.logger.debug(
        'listMyConsents: kullanıcının verdiği rızalar listeleniyor',
      );
      where = { petOwnerId: user.userId };
    }

    const [consent_res, total] = await this.prisma.$transaction([
      this.prisma.consent.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (request.page - 1) * request.pageSize,
        take: request.pageSize,
      }),
      this.prisma.consent.count({ where }),
    ]);

    this.logger.debug('listMyConsents: başarıyla tamamlandı');
    return {
      consents: consent_res.map((consent) =>
        user.role === 'CLINIC'
          ? { ...this.toConsentResponse(consent), ownerUserId: '' }
          : this.toConsentResponse(consent),
      ),
      total,
      page: request.page,
      pageSize: request.pageSize,
    };
  }
}
