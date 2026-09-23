import { Body, Controller, Post } from '@nestjs/common';
import { ApiAccessService } from './access.service';
import { ExchangeTokenRequestDto } from '@libs/dto';

@Controller('access')
export class ApiAccessController {
  constructor(private readonly accessService: ApiAccessService) {}

  // GEÇİCİ: access.proto ExchangeToken'ı "iç RPC, HTTP endpoint'i yok"
  // gerçek çağrı bir AuthGuard içinden yapılacak ve bu uç silinecek.
  @Post('exchange-token')
  exchangeToken(@Body() dto: ExchangeTokenRequestDto) {
    return this.accessService.exchangeToken(dto);
  }
}
