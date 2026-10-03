import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { access } from '@libs/proto';
import { firstValueFrom } from 'rxjs';
import { ResponseMessages } from '../enums';
import { setRequestJwt } from '../storage';
import { IS_PUBLIC_KEY } from '../decorator';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';

@Injectable()
export class TokenExchangeGuard implements CanActivate {
  private readonly logger = new Logger(TokenExchangeGuard.name);
  private accessClientService!: access.AccessServiceClient;

  constructor(
    @Inject('ACCESS_SERVICE') private readonly client: ClientGrpc,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    this.accessClientService = this.client.getService(
      access.ACCESS_SERVICE_NAME,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();

    const match = /^Bearer\s+(\S+)\s*$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match) {
      this.logger.warn('Header bulunamadı veya Bearer formatında değil.');
      throw new UnauthorizedException(ResponseMessages.UNAUTH);
    }
    const opaqueToken_in_data = match[1];

    const raw = request.headers['x-client-type'];
    const clientType =
      raw === '1'
        ? access.ClientType.WEB
        : raw === '2'
          ? access.ClientType.MOBILE
          : undefined;
    if (clientType === undefined) {
      this.logger.warn(`geçersiz x-client-type: ${String(raw)}`);
      throw new BadRequestException(ResponseMessages.INVALID_CLIENT_TYPE);
    }

    let access_response: access.ExchangeTokenResponse;
    try {
      access_response = await firstValueFrom(
        this.accessClientService.exchangeToken({
          opaqueToken: opaqueToken_in_data,
          clientType: clientType,
        }),
      );
    } catch (e) {
      if (e instanceof HttpException) throw e;

      const errorMessage = e instanceof Error ? e.message : String(e);

      const { code, details } = e as { code?: number; details?: string };
      if (details === ResponseMessages.TOKEN_EXPIRED)
        throw new UnauthorizedException(details);
      if (details === ResponseMessages.INVALID_TOKEN)
        throw new UnauthorizedException(details);
      if (code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED)
        throw new ServiceUnavailableException(
          ResponseMessages.SERVICE_UNAVAILABLE,
        );

      this.logger.error(`Opaque -> JWT çevrimi başarısız: ${errorMessage}`);
      throw new UnauthorizedException(ResponseMessages.UNAUTH);
    }

    setRequestJwt(access_response.jwt);
    return true;
  }
}
