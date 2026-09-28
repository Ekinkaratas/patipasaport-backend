import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MedicalRecordModule } from './app/medical-record.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { MEDICAL_RECORD_PACKAGE_NAME } from '@libs/proto';
import {
  RpcExceptionFilter,
  createGrpcValidationPipe,
  LoggingInterceptor,
  createWinstonLogger,
  GrpcCorrelationInterceptor,
} from '@libs/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    MedicalRecordModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3004',
        package: MEDICAL_RECORD_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/medical_record/medical_record.proto'),
      },
      logger: createWinstonLogger('medical-record'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('medical-record'),
  );

  await app.listen();
  Logger.log(`🚀 Application is running on medical_record`);
}

bootstrap();
