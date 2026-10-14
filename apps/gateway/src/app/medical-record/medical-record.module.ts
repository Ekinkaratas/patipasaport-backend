import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { MEDICAL_RECORD_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  requiredEnv,
} from '@libs/common';
import { ApiMedicalRecordService } from './medical-record.service';
import { ApiMedicalRecordController } from './medical-record.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'MEDICAL_RECORD_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: requiredEnv('MEDICAL_RECORD_GRPC_URL'),
          package: MEDICAL_RECORD_PACKAGE_NAME,
          loader: {
            defaults: true,
            arrays: true,
          },
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_GATEWAY_TIMEOUT_MS),
            ],
          },
          protoPath: join(
            __dirname,
            'proto/medical_record/medical_record.proto',
          ),
        },
      },
    ]),
  ],
  controllers: [ApiMedicalRecordController],
  providers: [ApiMedicalRecordService],
})
export class ApiMedicalRecordModule {}
