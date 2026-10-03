import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Metadata } from '@grpc/grpc-js';
import { readFileSync } from 'fs';
import { isUUID } from 'class-validator';
import { access } from '@libs/proto';
import { IS_PUBLIC_KEY, Roles } from '../decorator';
import { ResponseMessages, TOKEN_ROLES, TokenRole } from '../enums';
import { rejectRpc } from '../exceptions';
import { AUTHORIZATION_METADATA_KEY, CORRELATION_ID_HEADER } from '../storage';
import { AuthUser, setAuthUser } from './auth-user';

// access.module.ts'teki imzalama ayarıyla aynı olmalı.
const JWT_ISSUER = 'access';

interface AccessJwtClaims {
  sub: string;
  role: string;
  clinicId: string;
  clientType: number;
}

@Injectable()
export class GrpcJwtGuard implements CanActivate {
  private readonly logger = new Logger(GrpcJwtGuard.name);
  private readonly jwt: JwtService;

  constructor(
    config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    const publicKey = readFileSync(
      config.getOrThrow<string>('JWT_PUBLIC_KEY_PATH'),
      'utf8',
    );
    this.jwt = new JwtService({
      publicKey,
      verifyOptions: { algorithms: ['RS256'], issuer: JWT_ISSUER },
    });
  }

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const metadata = context.switchToRpc().getContext<Metadata>();
    // Guard interceptor'dan önce çalışır; correlationId henüz bağlamda değil.
    const correlationId =
      metadata.get(CORRELATION_ID_HEADER)[0]?.toString() ?? 'UNKNOWN';

    const header = metadata.get(AUTHORIZATION_METADATA_KEY)[0]?.toString();
    const token = header ? /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
    if (!token) {
      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        `JWT yok (correlationId=${correlationId})`,
      );
    }

    let claims: AccessJwtClaims;
    try {
      claims = this.jwt.verify<AccessJwtClaims>(token);
    } catch (e) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      rejectRpc(
        this.logger,
        expired
          ? ResponseMessages.TOKEN_EXPIRED
          : ResponseMessages.INVALID_TOKEN,
        `JWT doğrulanamadı: ${e instanceof Error ? e.message : String(e)} (correlationId=${correlationId})`,
      );
    }

    const user = GrpcJwtGuard.toAuthUser(claims);
    if (!user) {
      rejectRpc(
        this.logger,
        ResponseMessages.INVALID_TOKEN,
        `JWT içeriği beklenen şekilde değil (correlationId=${correlationId})`,
      );
    }

    const roles = this.reflector.getAllAndOverride(Roles, targets);
    if (roles && !roles.includes(user.role)) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `rol yetkisiz: ${user.role} (correlationId=${correlationId})`,
      );
    }

    setAuthUser(metadata, user);
    return true;
  }

  private static toAuthUser(claims: AccessJwtClaims): AuthUser | undefined {
    const validClientType =
      claims.clientType === access.ClientType.WEB ||
      claims.clientType === access.ClientType.MOBILE;

    if (
      typeof claims.sub !== 'string' ||
      !isUUID(claims.sub, '4') ||
      !TOKEN_ROLES.includes(claims.role as TokenRole) ||
      typeof claims.clinicId !== 'string' ||
      !validClientType
    ) {
      return undefined;
    }

    return {
      userId: claims.sub,
      role: claims.role as TokenRole,
      clinicId: claims.clinicId,
      clientType: claims.clientType,
    };
  }
}
