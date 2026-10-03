import { Body, Controller, Post } from '@nestjs/common';
import { ApiAccessService } from './access.service';
import { ExchangeTokenRequestDto } from '@libs/dto';
import { access } from '@libs/proto';
import { Public } from '@libs/common';

@Controller('access')
export class ApiAccessController {
  constructor(private readonly accessService: ApiAccessService) {}

  // GEÇİCİ: access.proto ExchangeToken'ı "iç RPC, HTTP endpoint'i yok"
  // gerçek çağrı bir AuthGuard içinden yapılacak ve bu uç silinecek.
  // @Public: global guard gelmeden önceki davranış korunur (test ucu).
  @Public()
  @Post('exchange-token')
  exchangeToken(@Body() dto: ExchangeTokenRequestDto) {
    return this.accessService.exchangeToken(dto);
  }

  // GEÇİCİ: access.proto createToken'ı "iç RPC, HTTP endpoint'i yok"
  // @Public: token almak için token istenemez (test ucu).
  @Public()
  @Post('create-token')
  createToken(
    @Body()
    dto: {
      userId: string;
      role: string;
      clinicId: string;
      clientType: access.ClientType;
      scopes: string[];
      ttlSeconds: number;
    },
  ) {
    return this.accessService.createToken(dto);
  }
}
