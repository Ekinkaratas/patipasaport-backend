import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClinicsModule } from './app/clinics.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CLINICS_PACKAGE_NAME } from '@libs/proto';
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
    ClinicsModule,
    {
      transport: Transport.GRPC,
      options: {
        url: `0.0.0.0:${process.env.PORT ?? 3003}`,
        package: CLINICS_PACKAGE_NAME,
        protoPath: join(__dirname, 'proto/clinics/clinics.proto'),
      },
      logger: createWinstonLogger('clinics'),
    },
  );

  app.useGlobalFilters(new RpcExceptionFilter());
  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(
    new GrpcCorrelationInterceptor(),
    new LoggingInterceptor('clinics'),
  );

  await app.listen();
  Logger.log(`🚀 Application is running on clinics`);
}

bootstrap();
