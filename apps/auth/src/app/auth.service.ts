import { access, auth, users } from '@libs/proto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import * as argon from 'argon2';
import { firstValueFrom, Observable } from 'rxjs';
import {
  DtoPrefix,
  rejectRpc,
  ResponseMessages,
  TokenRole,
} from '@libs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds,
} from './auth.constants';
import { ClientType, Prisma } from '../generated/prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private accessClient!: access.AccessServiceClient;
  private usersClient!: users.UsersServiceClient;

  constructor(
    @Inject('USERS_SERVICE') private readonly users_client: ClientGrpc,
    @Inject('ACCESS_SERVICE') private readonly access_client: ClientGrpc,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.accessClient =
      this.access_client.getService<access.AccessServiceClient>(
        access.ACCESS_SERVICE_NAME,
      );
    this.usersClient = this.users_client.getService<users.UsersServiceClient>(
      users.USERS_SERVICE_NAME,
    );
  }

  // servis içi içinde kullanılacak yardımcı metotlar

  // --- amaç: dinamik rollback sistemi (dış servisler kullanımına uygun ) ---
  private async rollback<T, K extends keyof T>(
    client: T,
    methodName: K,
    payload: T[K] extends (data: infer P) => unknown ? P : never,
    logContext: string,
  ): Promise<void> {
    try {
      const grpcMethod = client[methodName] as unknown as (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) => Observable<any>;

      await firstValueFrom(grpcMethod.call(client, payload));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);

      this.logger.error(
        `Rollback Başarısız! Metot: ${String(methodName)} | İşlem: ${logContext} | Nedeni: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // --- amaç: dinamik rollback sistemi (iç servisler kullanımına uygun ) ---
  private async rollbackLocal(
    operation: () => Promise<unknown>,
    logContext: string,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);

      this.logger.error(
        `Rollback Başarısız! İşlem: ${logContext} | Nedeni: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private forwardGrpcError(error: unknown, service: string): never {
    const { code, details } = (error ?? {}) as {
      code?: unknown;
      details?: unknown;
    };

    if (
      typeof details === 'string' &&
      (Object.values(ResponseMessages).includes(details as ResponseMessages) ||
        Object.values(DtoPrefix).some((prefix) => details.startsWith(prefix)))
    ) {
      throw new RpcException(details);
    }

    if (code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED) {
      rejectRpc(
        this.logger,
        ResponseMessages.SERVICE_UNAVAILABLE,
        `register: ${service} servisine ulaşılamadı (code=${String(code)})`,
      );
    }

    throw error;
  }

  private toDbClientType(clientType: auth.ClientType): ClientType {
    switch (clientType) {
      case auth.ClientType.WEB:
        return ClientType.WEB;
      case auth.ClientType.MOBILE:
        return ClientType.MOBILE;
      default:
        rejectRpc(
          this.logger,
          ResponseMessages.INVALID_CLIENT_TYPE,
          `refresh token: geçersiz clientType (${String(clientType)})`,
        );
    }
  }

  // Yeni bir refresh token üretir ve oturumunu sessions tablosuna yazar.
  private async createRefreshToken(
    userId: string,
    clientType: auth.ClientType,
    ttlSeconds: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<{ refreshToken: string; expiresAt: Date }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(
        `createRefreshToken: geçersiz ttlSeconds (${ttlSeconds})`,
      );
    }

    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    try {
      await tx.session.create({
        data: {
          userId,
          refreshTokenHash: AuthService.hashRefreshToken(refreshToken),
          clientType: this.toDbClientType(clientType),
          expiresAt,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2003') {
          rejectRpc(
            this.logger,
            ResponseMessages.INTERNAL_SERVER_ERROR,
            `createRefreshToken: userId FK ihlali (userId=${userId})`,
          );
        }

        if (e.code === 'P2002') {
          rejectRpc(
            this.logger,
            ResponseMessages.CONFLICT,
            `createRefreshToken: bu clientType icin zaten aktif oturum var (userId=${userId}, clientType=${clientType})`,
          );
        }
      }

      this.logger.error(
        `createRefreshToken: Oturum kaydedilirken veritabanı hatası oluştu (userId=${userId})`,
        e instanceof Error ? e.stack : undefined,
      );

      throw e;
    }

    return { refreshToken, expiresAt };
  }

  private static hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  private static toTokenRole(role: users.UserRole): TokenRole | undefined {
    switch (role) {
      case users.UserRole.PET_OWNER:
        return 'PET_OWNER';
      case users.UserRole.VETERINARIAN:
        return 'VETERINARIAN';
      case users.UserRole.STAFF:
        return 'STAFF';
      default:
        return undefined;
    }
  }

  // servis içi içinde kullanılacaklar
  async register(dto: auth.RegisterRequest): Promise<auth.TokenResponse> {
    this.logger.log(`register çağrılıyor (clientType=${dto.clientType})`);
    // ----Separation of Concerns----
    const { password, ...req } = dto;

    const passwordHash = await argon.hash(password);

    // ---user servisi çağrılıyor---
    this.logger.log(
      `user servisine  çağrılıyor (clientType=${dto.clientType})`,
    );

    let user_data: users.UserResponse;
    const userId = randomUUID();

    try {
      user_data = await firstValueFrom(
        this.usersClient.createUser({
          id: userId,
          email: req.email,
          fullName: req.fullName,
          phone: req.phone,
        }),
      );
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== status.UNAVAILABLE) {
        await this.rollback(
          this.usersClient,
          'deleteUser',
          {
            userId: userId,
          },
          `register: userCreate sırasında hata meydana geldi bundan dolayı rollback çağrıldı: userId = ${userId}`,
        );
      }
      this.forwardGrpcError(e, 'users');
    }

    const createdUser = user_data.user;
    const role = createdUser
      ? AuthService.toTokenRole(createdUser.role)
      : undefined;
    if (!createdUser || !role) {
      await this.rollback(
        this.usersClient,
        'deleteUser',
        {
          userId: userId,
        },
        `users yanıtı geçersiz olamsı sebebiyle user satırı silinmek üzere rollback çağrıldı(role=${String(createdUser?.role)})`,
      );
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `register: users yanıtı geçersiz (role=${String(createdUser?.role)})`,
      );
    }

    let refresh_token: {
      refreshToken: string;
      expiresAt: Date;
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        // --- 1. auth db veri oluşturuluyor ---
        this.logger.log(
          `auth db veri oluşturuluyor (clientType=${req.clientType})`,
        );
        const credential = await tx.credential.create({
          data: {
            userId,
            email: req.email,
            passwordHash: passwordHash,
          },
          select: {
            userId: true,
            email: true,
          },
        });

        // --- 2. auth servis de refresh_token oluşturuluyor ---
        refresh_token = await this.createRefreshToken(
          userId,
          req.clientType,
          refreshTokenTtlSeconds(false),
          tx,
        );

        return { credential, refresh_token };
      });
    } catch (e) {
      await this.rollback(
        this.usersClient,
        'deleteUser',
        { userId: userId },
        `Kayıt başarısız, Users servisindeki yetim kayıt siliniyor`,
      );

      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        rejectRpc(
          this.logger,
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          'register: email zaten kayıtlı',
        );
      }
      throw e;
    }

    // --- access servis çağrılıyor ---
    this.logger.log(
      `access servisi  çağrılıyor (clientType=${dto.clientType})`,
    );

    let opaque_token: access.CreateTokenResponse;

    const payload: access.CreateTokenRequest = {
      userId: userId,
      role,
      clinicId: createdUser.clinicId,
      clientType: req.clientType,
      scopes: [],
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };

    try {
      opaque_token = await firstValueFrom(
        this.accessClient.createOpaqueToken(payload),
      );
    } catch (e) {
      await this.rollbackLocal(
        () => this.deleteInCredential({ userId }),
        `register: access token alınamadı, credential ve bağlı oturumlar siliniyor (userId=${userId})`,
      );

      await this.rollback(
        this.usersClient,
        'deleteUser',
        { userId },
        `register: access token alinamadi, users kaydi geri aliniyor (userId=${userId})`,
      );

      this.forwardGrpcError(e, 'access');
    }

    // ---response hazırlığı---
    const response: auth.TokenResponse = {
      accessToken: opaque_token.opaqueToken,
      refreshToken: refresh_token.refreshToken,
      tokenType: 'Bearer',
      expiresIn: opaque_token.expiresIn,
      userId,
    };

    return response;
  }

  // --- Amaç: Credential tablosundaki ilgili satırı silmek ---
  async deleteInCredential(
    data: auth.DeleteInCredentialRequest,
  ): Promise<auth.DeleteInCredentialResponse> {
    if (!data.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'deleteInCredential: userId boş',
      );
    }

    try {
      await this.prisma.credential.delete({
        where: {
          userId: data.userId,
        },
      });

      return { deleted: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2025') {
          this.logger.warn(
            `deleteInCredential: kayıt bulunamadı, silinecek bir şey yok (userId=${data.userId})`,
          );
          return { deleted: false };
        }
        if (e.code === 'P2007') {
          rejectRpc(
            this.logger,
            ResponseMessages.BAD_REQUEST,
            'deleteInCredential: userId uuid formatında değil',
          );
        }
      }
      throw e;
    }
  }
}
