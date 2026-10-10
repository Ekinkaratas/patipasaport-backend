import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { auth } from '@libs/proto';
import { ResponseMessages } from '../enums';

@Injectable()
export class ClientTypeHeaderInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ClientTypeHeaderInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['x-client-type'];
    const clientType =
      raw === '1'
        ? auth.ClientType.WEB
        : raw === '2'
          ? auth.ClientType.MOBILE
          : undefined;

    if (clientType === undefined) {
      this.logger.warn(`geçersiz x-client-type: ${String(raw)}`);
      throw new BadRequestException(ResponseMessages.INVALID_CLIENT_TYPE);
    }

    request.body = { ...(request.body ?? {}), clientType };
    return next.handle();
  }
}
