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
  requiredEnv,
} from '@libs/common';
import { ACCESS_PACKAGE_NAME, PETS_PACKAGE_NAME } from '@libs/proto';
import { MedicalRecordController } from './medical-record.controller';
import { MedicalRecordService } from './medical-record.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RabbitMqService } from './messaging/rabbitmq.service';
import { OutboxRelayService } from './messaging/outbox-relay.service';
import { DocumentEventsConsumer } from './messaging/document-events.consumer';

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
        name: 'ACCESS_SERVICE',
        transport: Transport.GRPC,
        options: grpcClientOptions(
          requiredEnv('ACCESS_GRPC_URL'),
          ACCESS_PACKAGE_NAME,
          'access/access.proto',
        ),
      },
      {
        name: 'PETS_SERVICE',
        transport: Transport.GRPC,
        options: grpcClientOptions(
          requiredEnv('PETS_GRPC_URL'),
          PETS_PACKAGE_NAME,
          'pets/pets.proto',
        ),
      },
    ]),
  ],
  controllers: [MedicalRecordController],
  providers: [
    MedicalRecordService,
    RabbitMqService,
    OutboxRelayService,
    DocumentEventsConsumer,
    { provide: APP_GUARD, useClass: GrpcJwtGuard },
  ],
})
export class MedicalRecordModule {}
