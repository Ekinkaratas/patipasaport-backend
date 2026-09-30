import { users } from '@libs/proto';
import { Injectable, Logger } from '@nestjs/common';
import { rejectRpc, ResponseMessages } from '@libs/common';
import { PrismaService } from './prisma/prisma.service';
import {
  Prisma,
  User,
  UserRole as DbUserRole,
} from '../generated/prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // servis içi yardımcı metotlar
  private static toProtoRole(role: DbUserRole): users.UserRole {
    switch (role) {
      case DbUserRole.PET_OWNER:
        return users.UserRole.PET_OWNER;
      case DbUserRole.VETERINARIAN:
        return users.UserRole.VETERINARIAN;
      case DbUserRole.STAFF:
        return users.UserRole.STAFF;
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

  // servis içi metotlar
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
}
