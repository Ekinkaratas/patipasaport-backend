import { access, auth, users } from '@libs/proto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientGrpc, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import * as argon from 'argon2';
import { firstValueFrom, Observable } from 'rxjs';
import { rejectRpc, ResponseMessages, TokenRole } from '@libs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds,
} from './auth.constants';
import { ClientType, Prisma } from '../generated/prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  CreateTokenRequestDto,
  CreateTokenResponseDto,
  DeleteInCredentialRequestDto,
  GetUserAuthInfoResponseDto,
  UserResponseDto,
} from '@libs/dto';
import { LoginAttemptService } from './redis/login-attempt.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private accessClient!: access.AccessServiceClient;
  private usersClient!: users.UsersServiceClient;
  private dummyPasswordHash: string;

  constructor(
    @Inject('USERS_SERVICE') private readonly users_client: ClientGrpc,
    @Inject('ACCESS_SERVICE') private readonly access_client: ClientGrpc,
    private readonly prisma: PrismaService,
    private readonly loginAttempts: LoginAttemptService,
  ) {}

  async onModuleInit() {
    this.accessClient =
      this.access_client.getService<access.AccessServiceClient>(
        access.ACCESS_SERVICE_NAME,
      );
    this.usersClient = this.users_client.getService<users.UsersServiceClient>(
      users.USERS_SERVICE_NAME,
    );
    this.dummyPasswordHash = await argon.hash(randomBytes(32).toString('hex'));
  }

  // servis içi içinde kullanılacak yardımcı metotlar

  // --- Amaç: Credential tablosundaki ilgili satırı silmek ---
  private async deleteInCredential(
    data: DeleteInCredentialRequestDto,
  ): Promise<{ deleted: boolean }> {
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

  // --- Amaç: dış servisden gelen hatayı istemciye güvenli şekilde aktarmak ---
  private forwardGrpcError(
    error: unknown,
    context: string,
    allowed: readonly ResponseMessages[] = [],
  ): never {
    const { code, details } = (error ?? {}) as {
      code?: unknown;
      details?: unknown;
    };

    if (
      typeof details === 'string' &&
      allowed.includes(details as ResponseMessages)
    ) {
      throw new RpcException(details);
    }

    if (code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED) {
      rejectRpc(
        this.logger,
        ResponseMessages.SERVICE_UNAVAILABLE,
        `${context}: servise ulaşılamadı (code=${String(code)})`,
      );
    }

    rejectRpc(
      this.logger,
      ResponseMessages.INTERNAL_SERVER_ERROR,
      `${context}: beklenmeyen yanıt (code=${String(code)}, details=${String(details)})`,
    );
  }

  // --- Amaç: Client tipini DB için ygun dile çevirmek ---
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

  // --- Amaç: Yeni bir refresh token üretir ve oturumunu sessions tablosuna yazar. ---
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
      }

      this.logger.error(
        `createRefreshToken: Oturum kaydedilirken veritabanı hatası oluştu (userId=${userId})`,
        e instanceof Error ? e.stack : undefined,
      );

      throw e;
    }

    return { refreshToken, expiresAt };
  }

  // --- Amaç: Refresh token ı hashlemek ---
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

  //  --------------------------------------------servis içi içinde kullanılacaklar-------------------------------------------------

  // --- Amaç: user kaydı oluşturmak ---
  async register(dto: auth.RegisterRequest): Promise<auth.TokenResponse> {
    this.logger.log(`register çağrılıyor (clientType=${dto.clientType})`);
    // ----Separation of Concerns----
    const { password, ...req } = dto;

    const passwordHash = await argon.hash(password);

    //#region ---user servisi çağrılıyor---
    this.logger.log(
      `user servisine  çağrılıyor (clientType=${dto.clientType})`,
    );

    let user_data: UserResponseDto;
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
      if (code !== status.UNAVAILABLE && code !== status.ALREADY_EXISTS) {
        await this.rollback(
          this.usersClient,
          'deleteUser',
          {
            userId: userId,
          },
          `register: userCreate sırasında hata meydana geldi bundan dolayı rollback çağrıldı: userId = ${userId}`,
        );
      }
      this.forwardGrpcError(e, 'register: users.createUser', [
        ResponseMessages.EMAIL_ALREADY_EXISTS,
      ]);
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
    //#endregion

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

    //#region ---access servis çağrılıyor---
    this.logger.log(
      `access servisi  çağrılıyor (clientType=${dto.clientType})`,
    );

    let opaque_token: CreateTokenResponseDto;

    const payload: CreateTokenRequestDto = {
      userId: userId,
      role,
      clinicId: createdUser.clinicId,
      clientType: req.clientType,
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

      this.forwardGrpcError(e, 'register: access.createOpaqueToken');
    }
    //#endregion

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

  // --- Amaç: user girişini sağlamak ---
  async login(req: auth.LoginRequest): Promise<auth.TokenResponse> {
    this.logger.log('login servisi başlatılıyor');

    // Deneme şifre kontrolü yapılması sağlanır. 5'i aşan istek burada reddedilir.
    const attempt = await this.loginAttempts.reserveAttempt(req.email);

    this.logger.log('login: client doğrulama işlemi başladı');
    //#region -- login: client doğrulama işlemi --

    this.logger.log('login: credential veritabanına istek atıldı');

    const auth_db_data = await this.prisma.credential.findUnique({
      where: {
        email: req.email,
      },

      select: {
        userId: true,
        passwordHash: true,
      },
    });

    const is_verify_password: boolean = await argon.verify(
      auth_db_data?.passwordHash ?? this.dummyPasswordHash,
      req.password,
    );

    if (!auth_db_data || !is_verify_password) {
      await this.loginAttempts.recordFailure(req.email, attempt);
      rejectRpc(
        this.logger,
        ResponseMessages.PASSWORD_OR_EMAIL_WRONG,
        'doğrulama başarısız',
      );
    }

    await this.loginAttempts.reset(req.email);

    this.logger.log(
      `login: client doğrulama işlemi başarılı. (userId: ${auth_db_data.userId})`,
    );
    //#endregion

    this.logger.log(
      'login: user servisi çağrıldı kullanıcı bilgileri alınacak',
    );

    //#region -- login: users servisi çağrısı --
    let user_db_data: GetUserAuthInfoResponseDto;
    try {
      user_db_data = await firstValueFrom(
        this.usersClient.getUserAuthInfo({ userId: auth_db_data.userId }),
      );
    } catch (e) {
      // NOT_FOUND bilerek listede yok: credential var ama users satırı yoksa
      // bu bir veri tutarsızlığıdır, istemciye INTERNAL döner.
      this.forwardGrpcError(e, 'login: users.getUserAuthInfo', [
        ResponseMessages.ACCOUNT_DISABLED,
      ]);
    }
    this.logger.log('login: user servisi başarıyla tamamlandı');
    //#endregion

    this.logger.log(
      'login: opaque token üretimi için access servis çağrılıyor',
    );
    //#region -- login: access  servisi çağrısı --
    const payload: CreateTokenRequestDto = {
      userId: auth_db_data.userId,
      role: AuthService.toTokenRole(user_db_data.role),
      clinicId: user_db_data.clinicId,
      clientType: req.clientType,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };

    let access_response_data: CreateTokenResponseDto;
    try {
      access_response_data = await firstValueFrom(
        this.accessClient.createOpaqueToken(payload),
      );
    } catch (e) {
      this.forwardGrpcError(e, 'login: access.createOpaqueToken');
    }

    this.logger.log(
      'login: opaque token üretimi için access servis çağrısı başarıyla tamamlandı',
    );
    //#endregion

    this.logger.log('login: refresh token üretimi başladı');
    //#region -- login: refresh token üretimi ---
    let refresh_token_data: {
      refreshToken: string;
      expiresAt: Date;
    };

    this.logger.log('refresh_token oluşturuluyor');
    try {
      refresh_token_data = await this.createRefreshToken(
        auth_db_data.userId,
        req.clientType,
        refreshTokenTtlSeconds(req.rememberMe),
      );
    } catch (e) {
      this.logger.error(
        `refresh_token üretimi sırasında hata meydana geldi: (hata mesajı: ${e})`,
      );
      await this.rollback(
        this.accessClient,
        'revokeToken',
        { opaqueToken: access_response_data.opaqueToken },
        'refresh_token üretimi sırasında meydana gelen hatadan dolayı access client revoke metodu çalıştırıldı',
      );
      throw e;
    }

    this.logger.log('refresh_token başarıyla oluşturuldu');
    //#endregion

    const response: auth.TokenResponse = {
      accessToken: access_response_data.opaqueToken,
      refreshToken: refresh_token_data.refreshToken,
      tokenType: 'Bearer',
      expiresIn: access_response_data.expiresIn,
      userId: auth_db_data.userId,
    };

    this.logger.log('login: metodu başarıyla tamamlandı');
    return response;
  }
}
