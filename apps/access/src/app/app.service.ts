import { access } from '@libs/proto';
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { OpaqueTokenRecord, RedisService } from './redis/redis.service';
import { getCorrelationId, ResponseMessages } from '@libs/common';
import { JwtService } from '@nestjs/jwt';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';

@Injectable()
export class AppService {
  constructor(
    private readonly redis: RedisService,
    private readonly accessJwt: JwtService,
  ) {}

  // sadece access service methodları çağırıcak - Amaç: opaque token'ı kısa ömürlü(1 dk) JWT ye çeviricek ana fonksiyon -
  private async introspectOpaqueToken(
    opaqueToken: string,
    clientType: access.ClientType,
  ): Promise<OpaqueTokenRecord> {
    const record = await this.redis.getTokenRecord(opaqueToken);

    if (!record) {
      throw new RpcException(ResponseMessages.INVALID_TOKEN);
    }

    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.redis.deleteTokenRecord(opaqueToken);
      throw new RpcException(ResponseMessages.TOKEN_EXPIRED);
    }

    // proto: "Web'den çalınan token mobilde işe yaramaz"
    if (record.clientType !== clientType) {
      throw new RpcException(ResponseMessages.INVALID_TOKEN);
    }

    return record;
  }

  // sadece gateway çağırıcak - Amaç: opaque token'ı kısa ömürlü(1 dk) JWT ye çeviricek -
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
      scopes: record.scopes,
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
}
