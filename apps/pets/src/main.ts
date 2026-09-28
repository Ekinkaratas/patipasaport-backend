import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PetsModule } from './app/pets.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PETS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  RpcExceptionFilter,
  createGrpcValidationPipe,
  LoggingInterceptor,
  createWinstonLogger,
  GrpcCorrelationInterceptor,
} from '@libs/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    PetsModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3005',
        package: PETS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/pets/pets.proto'),
      },
      logger: createWinstonLogger('pets'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('pets'),
  );

  await app.listen();
  Logger.log(`🚀 Application is running on pets`);
}

bootstrap();
