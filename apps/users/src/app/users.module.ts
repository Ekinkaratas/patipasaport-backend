import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GrpcJwtGuard } from '@libs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class UsersModule {}
