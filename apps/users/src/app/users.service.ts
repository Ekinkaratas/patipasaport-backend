import { access, users } from '@libs/proto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  AuthUser,
  forwardGrpcError,
  rejectRpc,
  ResponseMessages,
} from '@libs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  Prisma,
  User,
  UserRole as DbUserRole,
} from '../generated/prisma/client';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);
  private accessClient!: access.AccessServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('ACCESS_SERVICE') private readonly access_client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.accessClient =
      this.access_client.getService<access.AccessServiceClient>(
        access.ACCESS_SERVICE_NAME,
      );
  }

  //#region  ---  servis içi yardımcı metotlar  ---
  private static toProtoRole(role: DbUserRole): users.UserRole {
    switch (role) {
      case DbUserRole.PET_OWNER:
        return users.UserRole.PET_OWNER;
      case DbUserRole.CLINIC:
        return users.UserRole.CLINIC;
    }
  }

  private static toProtoUser(user: User): users.User {
    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: UsersService.toProtoRole(user.role),
      clinicId: user.clinicId ?? '',
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private static uniqueConstraintName(
    e: Prisma.PrismaClientKnownRequestError,
  ): string | undefined {
    const meta = e.meta as
      | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
      | undefined;
    return meta?.driverAdapterError?.cause?.constraint?.index;
  }

  private userResponse(user: User): users.User {
    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: UsersService.toProtoRole(user.role),
      clinicId: user.clinicId || '',
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private async checkOwnerContactAccess(
    petId: string,
    user: AuthUser,
  ): Promise<access.CheckAccessResponse> {
    try {
      return await firstValueFrom(
        this.accessClient.checkAccess({
          clinicId: user.clinicId,
          petId,
          requiredScopes: ['owner_contact_read'],
        }),
      );
    } catch (e) {
      forwardGrpcError(this.logger, e, 'getUserContact: access.checkAccess');
    }
  }

  private rejectUniqueViolation(e: unknown, method_name: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const constraint = UsersService.uniqueConstraintName(e);

      if (constraint === 'users_email_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.EMAIL_ALREADY_EXISTS,
          `${method_name}: email zaten kayıtlı`,
        );
      }
      if (constraint === 'users_tel_no_key') {
        rejectRpc(
          this.logger,
          ResponseMessages.PHONE_ALREADY_EXISTS,
          `${method_name}: telefon zaten kayıtlı`,
        );
      }
      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        `${method_name}: beklenmeyen unique ihlali (constraint=${String(constraint)})`,
      );
    }
    throw e;
  }

  //#endregion

  //#region  ---  servis içi metotlar  ---

  //#region  --- public dekoratörü ile işaretlenen metotlar  ---
  async createUser(dto: users.CreateUserRequest): Promise<users.UserResponse> {
    try {
      const data = await this.prisma.user.create({
        data: {
          id: dto.id,
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
        },
      });

      return { user: UsersService.toProtoUser(data) };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const constraint = UsersService.uniqueConstraintName(e);

        if (constraint === 'users_email_key') {
          rejectRpc(
            this.logger,
            ResponseMessages.EMAIL_ALREADY_EXISTS,
            'createUser: email zaten kayıtlı',
          );
        }
        if (constraint === 'users_tel_no_key') {
          rejectRpc(
            this.logger,
            ResponseMessages.PHONE_ALREADY_EXISTS,
            'createUser: telefon zaten kayıtlı',
          );
        }
        rejectRpc(
          this.logger,
          ResponseMessages.INTERNAL_SERVER_ERROR,
          `createUser: beklenmeyen unique ihlali (constraint=${String(constraint)})`,
        );
      }
      throw e;
    }
  }

  async deleteUser(
    dto: users.UserFindByIdRequest,
  ): Promise<users.DeleteUserResponse> {
    if (!dto.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'deleteUser: userId boş',
      );
    }

    try {
      await this.prisma.user.delete({
        where: {
          id: dto.userId,
        },
      });

      return { deleted: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2025') {
          this.logger.warn(
            `deleteUser: kayıt bulunamadı, silinecek bir şey yok (userId=${dto.userId})`,
          );
          return { deleted: false };
        }
        if (e.code === 'P2007') {
          rejectRpc(
            this.logger,
            ResponseMessages.BAD_REQUEST,
            'deleteUser: userId uuid formatında değil',
          );
        }
      }
      throw e;
    }
  }

  async getUserAuthInfo(
    req: users.UserFindByIdRequest,
  ): Promise<users.GetUserAuthInfoResponse> {
    this.logger.log('getUserAuthInfo servisi çalıştırıldı');

    let user_db_data: Pick<User, 'id' | 'role' | 'clinicId' | 'isActive'>;
    try {
      this.logger.log('getUserAuthInfo: user db ye istek atıldı');
      user_db_data = await this.prisma.user.findUniqueOrThrow({
        where: {
          id: req.userId,
        },
        select: {
          id: true,
          role: true,
          clinicId: true,
          isActive: true,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `getUserAuthInfo: kullanıcı bulunamadı (userId: ${req.userId})`,
        );
      }
      throw e;
    }

    if (!user_db_data.isActive) {
      rejectRpc(
        this.logger,
        ResponseMessages.ACCOUNT_DISABLED,
        `getUserAuthInfo: hesap pasif (userId: ${user_db_data.id})`,
      );
    }

    this.logger.log('getUserAuthInfo: başarılı şekilde dönüş sağlandı');
    return {
      userId: user_db_data.id,
      role: UsersService.toProtoRole(user_db_data.role),
      clinicId: user_db_data.clinicId ?? '',
      isActive: user_db_data.isActive,
    };
  }

  //#endregion

  async getMe(user: AuthUser): Promise<users.GetMeResponse> {
    const me = await this.prisma.user.findUnique({
      where: { id: user.userId },
    });

    if (!me) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getMe: user bulunamadı (id: ${user.userId})`,
        'warn',
      );
    }

    if (!me.isActive) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `getMe: aktif değil (id: ${user.userId}, is_Active: ${me.isActive})`,
        'log',
      );
    }

    return this.userResponse(me);
  }

  async updateMe(
    request: users.UpdateMeRequest,
    user: AuthUser,
  ): Promise<users.UserResponse> {
    const control = Object.entries(request)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .filter(([_, val]) => val !== undefined && val !== '' && val !== null)
      .map(([key]) => key);

    if (control.length === 0) {
      rejectRpc(
        this.logger,
        ResponseMessages.BAD_REQUEST,
        'updateMe: gelen body içi boş',
      );
    }

    try {
      const updateUser: User = await this.prisma.user.update({
        where: { id: user.userId },
        data: {
          ...request,
        },
      });

      return { user: this.userResponse(updateUser) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2025') {
          rejectRpc(
            this.logger,
            ResponseMessages.NOT_FOUND,
            'updateMe: Güncellenmek istenen kullanıcı bulunamadı',
          );
        }

        if (e.code === 'P2002') {
          rejectRpc(
            this.logger,
            ResponseMessages.CONFLICT,
            'updateMe: Bu bilgiler (örneğin e-posta) başka bir kullanıcı tarafından kullanılıyor',
          );
        }
      }

      rejectRpc(
        this.logger,
        ResponseMessages.INTERNAL_SERVER_ERROR,
        'updateMe: Kullanıcı güncellenirken beklenmeyen bir hata oluştu',
      );
    }
  }

  async getUserRole(
    request: users.UserFindByIdRequest,
    user: AuthUser,
  ): Promise<users.GetUserRoleResponse> {
    const userRole = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: { id: true, role: true, clinicId: true },
    });

    if (!userRole) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getUserRole: user bulunamadı (id: ${user.userId})`,
      );
    }

    return {
      userId: userRole.id,
      role: UsersService.toProtoRole(userRole.role),
      clinicId: userRole.clinicId || '',
    };
  }

  async getUserDisplayNames(
    request: users.GetUserDisplayNamesRequest,
  ): Promise<users.GetUserDisplayNamesResponse> {
    const userDisplayNames = await this.prisma.user.findMany({
      where: { id: { in: request.userIds } },
      select: { id: true, fullName: true, role: true },
    });

    const userResponse = userDisplayNames.map((value) => ({
      ...value,
      userId: value.id,
      role: UsersService.toProtoRole(value.role),
    }));

    const existingIds = userDisplayNames.map((user) => user.id);

    const notFoundIds: string[] = request.userIds.filter(
      (requestedId) => !existingIds.includes(requestedId),
    );

    return {
      users: userResponse,
      notFoundIds: notFoundIds,
    };
  }

  async getUserContact(
    request: users.GetUserContactRequest,
    user: AuthUser,
  ): Promise<users.GetUserContactResponse> {
    const consent = await this.checkOwnerContactAccess(request.petId, user);

    if (!consent.allowed) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `getUserContact: owner_contact_read izni yok (clinicId=${user.clinicId} petId=${request.petId})`,
        'log',
      );
    }

    if (consent.petOwnerId !== request.userId) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getUserContact: kullanıcı rızayı veren pet sahibi değil (userId=${request.userId} petId=${request.petId})`,
        'warn',
      );
    }

    const contact = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        isActive: true,
      },
    });

    if (!contact || !contact.isActive) {
      rejectRpc(
        this.logger,
        ResponseMessages.NOT_FOUND,
        `getUserContact: kullanıcı yok ya da pasif (userId=${request.userId})`,
      );
    }

    return {
      userId: contact.id,
      fullName: contact.fullName,
      phone: contact.phone,
      email: contact.email,
    };
  }

  async createClinicUser(
    dto: users.CreateClinicUserRequest,
  ): Promise<users.UserResponse> {
    try {
      const data = await this.prisma.user.create({
        data: {
          id: dto.id,
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
          role: DbUserRole.CLINIC,
          clinicId: dto.clinicId,
        },
      });

      return { user: UsersService.toProtoUser(data) };
    } catch (e) {
      this.rejectUniqueViolation(e, 'createClinicUser');
    }
  }

  async deactivateMe(user: AuthUser): Promise<users.UserResponse> {
    try {
      const updated = await this.prisma.user.update({
        where: { id: user.userId },
        data: { isActive: false },
      });

      return { user: this.userResponse(updated) };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        rejectRpc(
          this.logger,
          ResponseMessages.NOT_FOUND,
          `deactivateMe: kullanıcı bulunamadı (userId=${user.userId})`,
          'warn',
        );
      }
      throw e;
    }
  }

  async deactivateClinicUsers(
    request: users.DeactivateClinicUsersRequest,
    user: AuthUser,
  ): Promise<users.DeactivateClinicUsersResponse> {
    if (request.clinicId !== user.clinicId) {
      rejectRpc(
        this.logger,
        ResponseMessages.FORBIDDEN,
        `deactivateClinicUsers: clinicId uyuşmazlığı (token=${user.clinicId} istek=${request.clinicId})`,
        'warn',
      );
    }

    const { count } = await this.prisma.user.updateMany({
      where: { clinicId: request.clinicId, role: DbUserRole.CLINIC },
      data: { isActive: false },
    });

    return { deactivatedCount: count };
  }

  //#endregion
}
