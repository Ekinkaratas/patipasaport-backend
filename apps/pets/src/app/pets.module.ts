import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  createGrpcDeadlineInterceptor,
  GRPC_INTERNAL_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  GrpcJwtGuard,
} from '@libs/common';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { join } from 'path';
import { ACCESS_PACKAGE_NAME } from '@libs/proto';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ChipCryptoService } from './crypto/chip-crypto.service';

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
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/access/access.proto'),
          loader: {
            defaults: true, // 0, false, "" gibi varsayılan değerleri objeye koyar
            arrays: true, // Boş listelerin undefined değil [] olarak dönmesini sağlar
          },
        },
      },
    ]),
  ],
  controllers: [PetsController],
  providers: [
    PetsService,
    { provide: APP_GUARD, useClass: GrpcJwtGuard },
    ChipCryptoService,
  ],
})
export class PetsModule {}
