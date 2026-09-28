import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AccessModule } from './app/access.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ACCESS_PACKAGE_NAME } from '@libs/proto';
import {
  createWinstonLogger,
  GrpcCorrelationInterceptor,
  LoggingInterceptor,
  RpcExceptionFilter,
  createGrpcValidationPipe,
} from '@libs/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AccessModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3001',
        package: ACCESS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/access/access.proto'),
      },
      logger: createWinstonLogger('access'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('access'),
  );

  await app.listen();
  Logger.log(`🚀 Application is running on access`);
}

bootstrap();
