import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_INTERNAL_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  GrpcJwtGuard,
} from '@libs/common';
import { ACCESS_PACKAGE_NAME } from '@libs/proto';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ClientsModule.register([
      {
        name: 'ACCESS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.ACCESS_GRPC_URL ?? '0.0.0.0:3001',
          package: ACCESS_PACKAGE_NAME,
          protoPath: join(__dirname, 'proto/access/access.proto'),
          loader: {
            defaults: true,
            arrays: true,
          },
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
        },
      },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class UsersModule {}
