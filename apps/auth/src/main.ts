import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AuthModule } from './app/auth.module';
import { AUTH_PACKAGE_NAME } from '@libs/proto';
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
    AuthModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3002',
        package: AUTH_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/auth/auth.proto'),
      },
      logger: createWinstonLogger('auth'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('auth'),
  );

  await app.listen();

  Logger.log(`🚀 Application is running on`);
}

bootstrap();
