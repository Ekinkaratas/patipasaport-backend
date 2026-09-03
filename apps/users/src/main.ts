import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { USERS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3006',
        package: USERS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/users/users.proto'),
      },
    },
  );
  await app.listen();
  Logger.log(`🚀 Application is running on users`);
}

bootstrap();
