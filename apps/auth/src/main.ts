import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app/app.module';
import { AUTH_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
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
        url: '0.0.0.0:3002',
        package: AUTH_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/auth/auth.proto'),
      },
      logger: createWinstonLogger('auth'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor('auth'));

  await app.listen();

  Logger.log(`🚀 Application is running on`);
}

bootstrap();
