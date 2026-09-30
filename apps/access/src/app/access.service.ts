import { access } from '@libs/proto';
import { Injectable } from '@nestjs/common';
import { OpaqueTokenRecord, RedisService } from './redis/redis.service';
import {
  getCorrelationId,
  rejectRpc,
  ResponseMessages,
  TOKEN_ROLES,
  TokenRole,
} from '@libs/common';
import { isUUID } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';
import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly accessJwt: JwtService,
  ) {}

  // ------------sadece access service methodları çağırıcak-------------

  // - Amaç: opaque token'ı üretmek -
  private generateOpaqueToken(): string {
    this.logger.log('generateOpaqueToken metodunda Opaque token üretildi');
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
    const opaqueToken = this.generateOpaqueToken();

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

    return {
      opaqueToken,
      expiresIn: created.ttlSeconds,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
    };
  }

  // ------------sadece gateway çağırıcak-------------

  //- Amaç: opaque token'ı kısa ömürlü(1 dk) JWT ye çeviricek -
  async exchangeToken(
    request: access.ExchangeTokenRequest,
  ): Promise<access.ExchangeTokenResponse> {
    const record = await this.introspectOpaqueToken(
      request.opaqueToken,
      request.clientType,
    );

    const jwt = this.accessJwt.sign({
      sub: record.userId,
      role: record.role,
      clinicId: record.clinicId,
      clientType: record.clientType,
    });

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

  // - Amaç: Opaque token oluşumu ve redis'e kayıt -
  async createOpaqueToken(
    request: access.CreateTokenRequest,
  ): Promise<access.CreateTokenResponse> {
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
        'klinik personeli için clinicId zorunlu',
      );
    }
    if (hasClinic && !isUUID(request.clinicId, '4')) {
      rejectRpc(
        this.logger,
        ResponseMessages.VALIDATION_ERROR,
        'clinicId UUID v4 değil',
      );
    }

    return this.registerUserToken({
      ...request,
    });
  }

  // - Amaç: Opaque tokenı redis'den silme -
  async revokeToken(
    data: access.RevokeTokenRequest,
  ): Promise<access.RevokeTokenResponse> {
    if (!data.opaqueToken || data.opaqueToken.trim() === '') {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'deleteOpaqueToken: opaqueToken doğru formatta değil veya boş',
      );
    }

    try {
      const deletedCount = await this.redis.deleteTokenRecord(data.opaqueToken);

      if (deletedCount === false) {
        this.logger.warn(
          `deleteOpaqueToken: kayıt bulunamadı, silinecek bir şey yok.`,
        );
        return { revoked: false };
      }

      return { revoked: true };
    } catch (error) {
      this.logger.error(
        `deleteOpaqueToken: Redis silme işleminde kritik hata `,
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }
}
