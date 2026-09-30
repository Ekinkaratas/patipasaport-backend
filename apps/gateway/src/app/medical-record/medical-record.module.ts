import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { MEDICAL_RECORD_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcCorrelationClientInterceptor,
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
          url: process.env.MEDICAL_RECORD_GRPC_URL ?? '0.0.0.0:3004',
          package: MEDICAL_RECORD_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
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
