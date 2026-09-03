import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CLINICS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3003',
        package: CLINICS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/clinics/clinics.proto'),
      },
    },
  );

  await app.listen();
  Logger.log(`🚀 Application is running on clinics`);
}

bootstrap();
