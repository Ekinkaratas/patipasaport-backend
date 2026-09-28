import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { UsersModule } from './app/users.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { USERS_PACKAGE_NAME } from '@libs/proto';
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
    UsersModule,
    {
      transport: Transport.GRPC,
      options: {
        url: '0.0.0.0:3006',
        package: USERS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/users/users.proto'),
      },
      logger: createWinstonLogger('users'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('users'),
  );

  await app.listen();
  Logger.log(`🚀 Application is running on users`);
}

bootstrap();
