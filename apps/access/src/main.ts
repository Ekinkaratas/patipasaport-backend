import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ACCESS_PACKAGE_NAME } from '@libs/proto';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3001',
        package: ACCESS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/access/access.proto'),
      },
    },
  );

  await app.listen();
  Logger.log(`🚀 Application is running on access`);
}

bootstrap();
