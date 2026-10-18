import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CLINICS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  requiredEnv,
} from '@libs/common';
import { ApiClinicsService } from './clinics.service';
import { ApiClinicsController } from './clinics.controller';
import { DocumentStorageModule } from '../storage/document-storage.module';

@Module({
  imports: [
    DocumentStorageModule,
    ClientsModule.register([
      {
        name: 'CLINICS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: requiredEnv('CLINICS_GRPC_URL'),
          package: CLINICS_PACKAGE_NAME,
          loader: {
            defaults: true,
            arrays: true,
            longs: Number,
          },
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_GATEWAY_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/clinics/clinics.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiClinicsController],
  providers: [ApiClinicsService],
})
export class ApiClinicsModule {}
