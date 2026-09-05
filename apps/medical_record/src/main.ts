import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { MEDICAL_RECORD_PACKAGE_NAME } from '@libs/proto';
import {
  RpcExceptionFilter,
  LoggingInterceptor,
  createWinstonLogger,
} from '@libs/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
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
  app.useGlobalInterceptors(new LoggingInterceptor('medical-record'));

  await app.listen();
  Logger.log(`🚀 Application is running on medical_record`);
}

bootstrap();
