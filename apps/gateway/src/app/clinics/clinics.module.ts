import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CLINICS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
} from '@libs/common';
import { ApiClinicsService } from './clinics.service';
import { ApiClinicsController } from './clinics.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'CLINICS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.CLINICS_GRPC_URL ?? '0.0.0.0:3003',
          package: CLINICS_PACKAGE_NAME,
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
