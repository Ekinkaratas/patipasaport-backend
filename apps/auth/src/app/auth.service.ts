import { access, auth, users } from '@libs/proto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import * as argon from 'argon2';
import { firstValueFrom } from 'rxjs';
import {
  forwardGrpcError,
  rejectRpc,
  ResponseMessages,
  rollback,
  rollbackLocal,
  TokenRole,
} from '@libs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_REUSE_TOLERANCE_SECONDS,
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

interface SessionSpec {
  userId: string;
  clientType: auth.ClientType;
  rememberMe: boolean;
  familyId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private accessClient!: access.AccessServiceClient;
  private usersClient!: users.UsersServiceClient;
  private dummyPasswordHash!: string;

  constructor(
    @Inject('USERS_SERVICE') private readonly users_client: ClientGrpc,
    @Inject('ACCESS_SERVICE')
    private readonly access_client: ClientGrpc,
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

  //#region  -------------------------------------------servis içi içinde kullanılacak yardımcı metotlar------------------------------------------------------------

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
    spec: SessionSpec,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = AuthService.refreshExpiresAt(spec.rememberMe);
    await tx.session.create({
      data: {
        userId: spec.userId,
        familyId: spec.familyId,
        refreshTokenHash: AuthService.hashRefreshToken(refreshToken),
        clientType: this.toDbClientType(spec.clientType),
        rememberMe: spec.rememberMe,
        expiresAt,
      },
    });
    return { refreshToken, expiresAt };
  }

  // --- Amaç: refresh token bitiş zamanını "oturumu hatırla" seçimine göre hesaplamak ---
  private static refreshExpiresAt(rememberMe: boolean): Date {
    return new Date(Date.now() + refreshTokenTtlSeconds(rememberMe) * 1000);
  }

  // --- Amaç: eskiyi atomik iptal + yenisini yaz, tek transaction. ---
  private async rotateRefreshToken(oldHash: string, spec: SessionSpec) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: {
          refreshTokenHash: oldHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });
      if (count !== 1) {
        rejectRpc(
          this.logger,
          ResponseMessages.UNAUTH,
          'refreshToken: iptal edilmiş, süresi dolmuş ya da yarışı kaybetti',
        );
      }

      await tx.session.deleteMany({
        where: {
          familyId: spec.familyId,
          refreshTokenHash: { not: oldHash },
          revokedAt: { not: null },
        },
      });

      return this.createRefreshToken(spec, tx);
    });
  }

  // --- Amaç: tokenlar için gerekli bilgileri almak için users servisine çağrı yapar. ---
  private async GetUserAuthInfoForAuth(userId: string, service_name: string) {
    try {
      return await firstValueFrom(
        this.usersClient.getUserAuthInfo({ userId: userId }),
      );
    } catch (e) {
      forwardGrpcError(
        this.logger,
        e,
        `${service_name}: users.getUserAuthInfo`,
        [ResponseMessages.ACCOUNT_DISABLED],
      );
    }
  }

  // --- Amaç: token üretimini ve refresh token db kaydını yapar (replacesHash varsa rotation). ---
  private async createTokens(
    payload: CreateTokenRequestDto,
    service_name: string,
    session: { rememberMe: boolean; familyId?: string; replacesHash?: string },
  ): Promise<{
    access_response_data: CreateTokenResponseDto;
    refresh_token_data: {
      refreshToken: string;
      expiresAt: Date;
    };
  }> {
    this.logger.log(
      `${service_name}: opaque token üretimi için access servis çağrılıyor`,
    );
    //#region -- access  servisi çağrısı --

    let access_response_data: CreateTokenResponseDto;
    try {
      access_response_data = await firstValueFrom(
        this.accessClient.createOpaqueToken(payload),
      );
    } catch (e) {
      forwardGrpcError(
        this.logger,
        e,
        `${service_name}: access.createOpaqueToken`,
      );
    }

    this.logger.log(
      `${service_name}: opaque token üretimi için access servis çağrısı başarıyla tamamlandı`,
    );
    //#endregion

    this.logger.log(`${service_name}: refresh token üretimi başladı`);

    //#region -- refresh token üretimi ---
    let refresh_token_data: {
      refreshToken: string;
      expiresAt: Date;
    };

    const spec: SessionSpec = {
      userId: payload.userId,
      clientType: payload.clientType,
      rememberMe: session.rememberMe,
      familyId: session.familyId ?? randomUUID(),
    };

    try {
      refresh_token_data = session.replacesHash
        ? await this.rotateRefreshToken(session.replacesHash, spec)
        : await this.createRefreshToken(spec);
    } catch (e) {
      this.logger.error(
        `refresh_token üretimi sırasında hata meydana geldi: (hata mesajı: ${e})`,
      );
      await rollback(
        this.logger,
        this.accessClient,
        'revokeToken',
        { opaqueToken: access_response_data.opaqueToken },
        'refresh_token üretimi sırasında meydana gelen hatadan dolayı access client revoke metodu çalıştırıldı',
      );
      throw e;
    }

    this.logger.log('refresh_token başarıyla oluşturuldu');
    return {
      access_response_data,
      refresh_token_data,
    };
    //#endregion
  }

  // --- Amaç: Refresh token ı hashlemek ---
  private static hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  private static toTokenRole(role: users.UserRole): TokenRole | undefined {
    switch (role) {
      case users.UserRole.PET_OWNER:
        return 'PET_OWNER';
      case users.UserRole.CLINIC:
        return 'CLINIC';
      default:
        return undefined;
    }
  }
  //#endregion

  //#region  --------------------------------------------servis içi içinde kullanılacaklar-------------------------------------------------

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
        await rollback(
          this.logger,
          this.usersClient,
          'deleteUser',
          {
            userId: userId,
          },
          `register: userCreate sırasında hata meydana geldi bundan dolayı rollback çağrıldı: userId = ${userId}`,
        );
      }
      forwardGrpcError(this.logger, e, 'register: users.createUser', [
        ResponseMessages.EMAIL_ALREADY_EXISTS,
      ]);
    }

    const createdUser = user_data.user;
    const role = createdUser
      ? AuthService.toTokenRole(createdUser.role)
      : undefined;
    if (!createdUser || !role) {
      await rollback(
        this.logger,
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

    let token: {
      refreshToken: string;
      expiresAt: Date;
    };
    let refresh: {
      credential: { userId: string; email: string };
      token: { refreshToken: string; expiresAt: Date };
    };

    try {
      refresh = await this.prisma.$transaction(async (tx) => {
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
        token = await this.createRefreshToken(
          {
            userId,
            clientType: req.clientType,
            rememberMe: false,
            familyId: randomUUID(),
          },
          tx,
        );

        return { credential, token };
      });
    } catch (e) {
      await rollback(
        this.logger,
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
      await rollbackLocal(
        this.logger,
        () => this.deleteInCredential({ userId }),
        `register: access token alınamadı, credential ve bağlı oturumlar siliniyor (userId=${userId})`,
      );

      await rollback(
        this.logger,
        this.usersClient,
        'deleteUser',
        { userId },
        `register: access token alinamadi, users kaydi geri aliniyor (userId=${userId})`,
      );

      forwardGrpcError(this.logger, e, 'register: access.createOpaqueToken');
    }

    //#endregion

    // ---response hazırlığı---
    const response: auth.TokenResponse = {
      accessToken: opaque_token.opaqueToken,
      refreshToken: refresh.token.refreshToken,
      tokenType: 'Bearer',
      expiresIn: opaque_token.expiresIn,
      userId,
    };

    return response;
  }

  async registerClinicAccount(
    dto: auth.RegisterClinicAccountRequest,
  ): Promise<auth.RegisterClinicAccountResponse> {
    const passwordHash = await argon.hash(dto.password);
    const userId = randomUUID();

    let user_data: UserResponseDto;
    try {
      user_data = await firstValueFrom(
        this.usersClient.createClinicUser({
          id: userId,
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
          clinicId: dto.clinicId,
        }),
      );
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== status.UNAVAILABLE && code !== status.ALREADY_EXISTS) {
        await rollback(
          this.logger,
          this.usersClient,
          'deleteUser',
          { userId },
          `registerClinicAccount: users.createClinicUser hata verdi, users kaydı geri alınıyor (userId=${userId})`,
        );
      }
      forwardGrpcError(
        this.logger,
        e,
        'registerClinicAccount: users.createClinicUser',
        [
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          ResponseMessages.PHONE_ALREADY_EXISTS,
        ],
      );
    }

    const createdUser = user_data.user;
    if (
      createdUser?.role !== users.UserRole.CLINIC ||
      createdUser.clinicId !== dto.clinicId
    ) {
      await rollback(
        this.logger,
        this.usersClient,
        'deleteUser',
        { userId },
        `registerClinicAccount: users yanıtı geçersiz, users kaydı geri alınıyor (userId=${userId})`,
      );
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `registerClinicAccount: users yanıtı geçersiz (role=${String(createdUser?.role)} clinicId=${String(createdUser?.clinicId)})`,
      );
    }

    try {
      await this.prisma.credential.create({
        data: { userId, email: dto.email, passwordHash },
      });
    } catch (e) {
      await rollback(
        this.logger,
        this.usersClient,
        'deleteUser',
        { userId },
        `registerClinicAccount: credential yazılamadı, users kaydı geri alınıyor (userId=${userId})`,
      );

      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        rejectRpc(
          this.logger,
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          'registerClinicAccount: email zaten kayıtlı',
        );
      }
      throw e;
    }

    return { userId };
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
    const user_db_data: GetUserAuthInfoResponseDto =
      await this.GetUserAuthInfoForAuth(auth_db_data.userId, 'login');

    this.logger.log('login: user servisi başarıyla tamamlandı');
    //#endregion

    const role_res = AuthService.toTokenRole(user_db_data.role);

    if (!role_res) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `login: Yetkisiz erişim girişimi! Kullanıcı kendisine ait olmayan bir kayıt üzerinde işlem yapmaya çalıştı`,
        'warn',
      );
    }

    //#region -- login: tokens metot çağrısı --
    const payload: CreateTokenRequestDto = {
      userId: auth_db_data.userId,
      role: role_res,
      clinicId: user_db_data.clinicId,
      clientType: req.clientType,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };

    const { access_response_data, refresh_token_data } =
      await this.createTokens(payload, 'login', {
        rememberMe: req.rememberMe,
      });

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

  // --- Amaç: token verilerini güncellemek ---
  async refreshToken(
    req: auth.RefreshTokenRequest,
  ): Promise<auth.TokenResponse> {
    this.logger.log('istek refreshToken metoduna geldi');

    const refreshToken_hash = AuthService.hashRefreshToken(req.refreshToken);

    this.logger.log('refreshToken: session schemasında arama başlatıldı');

    //#region -- refreshToken: session schemasında araması ve kontroller --
    const session = await this.prisma.session.findUnique({
      where: {
        refreshTokenHash: refreshToken_hash,
      },
      select: {
        userId: true,
        familyId: true,
        clientType: true,
        rememberMe: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!session) {
      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        'refreshToken: oturum bulunamadı',
      );
    }

    if (session.revokedAt) {
      const isRace =
        Date.now() - session.revokedAt.getTime() <=
        REFRESH_REUSE_TOLERANCE_SECONDS * 1000;

      if (!isRace) {
        await this.prisma.session.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        isRace
          ? 'refreshToken: eşzamanlı yenileme (tolerans içinde)'
          : `refreshToken: iptal edilmiş token tekrar kullanıldı, aile iptal edildi (familyId=${session.familyId})`,
        isRace ? undefined : 'warn',
      );
    }

    if (session.expiresAt <= new Date()) {
      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        'refreshToken: Oturum süresi dolmuş',
      );
    }

    if (session.clientType !== this.toDbClientType(req.clientType)) {
      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        `refreshToken: clientType uyuşmazlığı (oturum=${session.clientType})`,
        'warn',
      );
    }
    //#endregion

    this.logger.log(
      'refreshToken: user servisi çağrıldı kullanıcı bilgileri alınacak',
    );

    //#region -- refreshToken: users servisi çağrısı --
    const user_db_data: GetUserAuthInfoResponseDto =
      await this.GetUserAuthInfoForAuth(session.userId, 'refreshToken');

    this.logger.log('refreshToken: user servisi başarıyla tamamlandı');
    //#endregion

    //#region -- refreshToken: CreateTokens metot çağrısı (rotation) --

    const role_res = AuthService.toTokenRole(user_db_data.role);

    if (!role_res) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `refreshToken: Yetkisiz erişim  girişimi! Kullanıcı kendisine ait olmayan bir kayıt üzerinde işlem yapmaya çalıştı`,
        'warn',
      );
    }

    // clientType yukarıda oturumdakiyle eşleştirildi; yeni token'lar oturumun türüne bağlanır.
    const payload: CreateTokenRequestDto = {
      userId: session.userId,
      role: role_res,
      clinicId: user_db_data.clinicId,
      clientType: req.clientType,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };

    const { access_response_data, refresh_token_data } =
      await this.createTokens(payload, 'refreshToken', {
        rememberMe: session.rememberMe,
        familyId: session.familyId,
        replacesHash: refreshToken_hash,
      });
    //#endregion

    const response: auth.TokenResponse = {
      accessToken: access_response_data.opaqueToken,
      refreshToken: refresh_token_data.refreshToken,
      tokenType: 'Bearer',
      expiresIn: access_response_data.expiresIn,
      userId: session.userId,
    };

    this.logger.log('refreshToken: metodu başarıyla tamamlandı');
    return response;
  }

  async logout(request: auth.LogoutRequest): Promise<auth.LogoutResponse> {
    this.logger.log('istek logout metoduna geldi');

    const refreshToken_hash = AuthService.hashRefreshToken(
      request.refreshToken,
    );

    //#region -- logout: session schemasında araması ve familyId seçilmesi --

    this.logger.log('logout: session schemasında istek atıldı');

    const session = await this.prisma.$transaction(async (tx) => {
      const db_familyId_res = await tx.session.findUnique({
        where: {
          refreshTokenHash: refreshToken_hash,
        },
        select: {
          familyId: true,
        },
      });

      if (!db_familyId_res) {
        rejectRpc(
          this.logger,
          ResponseMessages.UNAUTH,
          'logout: oturum bulunamadı',
        );
      }

      const db_deleteMany_res = await tx.session.deleteMany({
        where: {
          familyId: db_familyId_res.familyId,
        },
      });

      return { count: db_deleteMany_res.count };
    });

    if (session.count === 0) {
      rejectRpc(
        this.logger,
        ResponseMessages.UNAUTH,
        'Silinecek oturum bulunamadı',
      );
    } else {
      this.logger.log(
        `logout: cihaz oturumu kapatıldı (silinen session satırı: ${session.count})`,
      );
    }

    //#endregion

    //#region --- access servisine itek atılıyor ---

    if (request.opaqueToken) {
      await rollback(
        this.logger,
        this.accessClient,
        'revokeToken',
        {
          opaqueToken: request.opaqueToken,
        },
        `logout: oturum kapatıldı ama access token iptal edilemedi; süresi dolana kadar (en fazla 15 dk) geçerli kalacak`,
      );
    }
    //#endregion

    this.logger.log('logout: başarıyla tamamlandı');
    return {
      success: true,
    };
  }

  //#endregion
}
