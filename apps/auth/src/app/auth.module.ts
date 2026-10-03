import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ACCESS_PACKAGE_NAME, USERS_PACKAGE_NAME } from '@libs/proto';
import {
  createGrpcDeadlineInterceptor,
  GRPC_INTERNAL_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  GrpcJwtGuard,
} from '@libs/common';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    ClientsModule.register([
      {
        name: 'ACCESS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.ACCESS_GRPC_URL ?? '0.0.0.0:3001',
          package: ACCESS_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/access/access.proto'),
        },
      },
      {
        name: 'USERS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.USERS_GRPC_URL ?? '0.0.0.0:3006',
          package: USERS_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/users/users.proto'),
        },
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class AuthModule {}
