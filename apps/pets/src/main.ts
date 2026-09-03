import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PETS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3005',
        package: PETS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/pets/pets.proto'),
      },
    },
  );

  await app.listen();
  Logger.log(`🚀 Application is running on pets`);
}

bootstrap();
