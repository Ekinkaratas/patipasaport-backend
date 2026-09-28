import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { access } from '@libs/proto';
import { getCorrelationId } from '@libs/common';
import { ExchangeTokenRequestDto } from '@libs/dto';

@Injectable()
export class ApiAccessService implements OnModuleInit {
  private readonly logger = new Logger(ApiAccessService.name);
  private accessClient!: access.AccessServiceClient;

  constructor(@Inject('ACCESS_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.accessClient = this.client.getService<access.AccessServiceClient>(
      access.ACCESS_SERVICE_NAME,
    );
  }

  async exchangeToken(
    dto: ExchangeTokenRequestDto,
  ): Promise<access.ExchangeTokenResponse> {
    this.logger.log(`ExchangeToken çağrılıyor (clientType=${dto.clientType})`);

    const response = await firstValueFrom(this.accessClient.exchangeToken(dto));

    const correlationId = getCorrelationId();
    if (response.traceId && response.traceId !== correlationId) {
      this.logger.warn(
        `traceId uyuşmuyor: ${response.traceId} != ${correlationId}`,
      );
    }

    return response;
  }

  async createToken(dto: {
    userId: string;
    role: string;
    clinicId: string;
    clientType: access.ClientType;
    scopes: string[];
    ttlSeconds: number;
  }) {
    const response = await firstValueFrom(
      this.accessClient.createOpaqueToken(dto),
    );

    return response;
  }
}
