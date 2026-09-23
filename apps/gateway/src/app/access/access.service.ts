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

  // getService constructor'da çağrılamaz; client proxy'si modül init'te hazır olur.
  onModuleInit() {
    this.accessClient = this.client.getService<access.AccessServiceClient>(
      access.ACCESS_SERVICE_NAME,
    );
  }

  async exchangeToken(
    dto: ExchangeTokenRequestDto,
  ): Promise<access.ExchangeTokenResponse> {
    // correlationId'yi elle taşımicaz:
    // access.module.ts'teki channelOptions.interceptors ALS'ten okuyup metadata'ya kendisi basıyor.
    // Bu log satırına da elle yazmıyoruz: Winston formatı her satıra basıyor.
    this.logger.log(`ExchangeToken çağrılıyor (clientType=${dto.clientType})`);

    const response = await firstValueFrom(this.accessClient.exchangeToken(dto));

    // correlationId'nin ELLE okunması gereken yer:
    // ALS'in erişemediği bir veri alanıyla karşılaştırmak/onu doldurmak.
    const correlationId = getCorrelationId();
    if (response.traceId && response.traceId !== correlationId) {
      this.logger.warn(
        `traceId uyuşmuyor: ${response.traceId} != ${correlationId}`,
      );
    }

    return response;
  }
}
