import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, GrpcOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_INTERNAL_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  GrpcJwtGuard,
} from '@libs/common';
import {
  MEDICAL_RECORD_PACKAGE_NAME,
  PETS_PACKAGE_NAME,
  USERS_PACKAGE_NAME,
} from '@libs/proto';
import { ClinicsController } from './clinics.controller';
import { ClinicsService } from './clinics.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

const grpcClientOptions = (
  url: string,
  packageName: string,
  protoFile: string,
): GrpcOptions['options'] => ({
  url,
  package: packageName,
  protoPath: join(__dirname, `proto/${protoFile}`),
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
});

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ClientsModule.register([
      {
        name: 'PETS_SERVICE',
        transport: Transport.GRPC,
        options: grpcClientOptions(
          process.env.PETS_GRPC_URL ?? '0.0.0.0:3005',
          PETS_PACKAGE_NAME,
          'pets/pets.proto',
        ),
      },
      {
        name: 'USERS_SERVICE',
        transport: Transport.GRPC,
        options: grpcClientOptions(
          process.env.USERS_GRPC_URL ?? '0.0.0.0:3006',
          USERS_PACKAGE_NAME,
          'users/users.proto',
        ),
      },
      {
        name: 'MEDICAL_RECORD_SERVICE',
        transport: Transport.GRPC,
        options: grpcClientOptions(
          process.env.MEDICAL_RECORD_GRPC_URL ?? '0.0.0.0:3004',
          MEDICAL_RECORD_PACKAGE_NAME,
          'medical_record/medical_record.proto',
        ),
      },
    ]),
  ],
  controllers: [ClinicsController],
  providers: [ClinicsService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class ClinicsModule {}
