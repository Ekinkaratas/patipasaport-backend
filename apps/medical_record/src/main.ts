/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { MEDICAL_RECORD_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';

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
    },
  );
  await app.listen();
  Logger.log(`🚀 Application is running on medical_record`);
}

bootstrap();
