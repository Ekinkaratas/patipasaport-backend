import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  createGrpcDeadlineInterceptor,
  GRPC_INTERNAL_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  GrpcJwtGuard,
} from '@libs/common';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from './redis/redis.module';
import { PrismaModule } from './prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { readFileSync } from 'fs';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';
import { join } from 'path';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CLINICS_PACKAGE_NAME, PETS_PACKAGE_NAME } from '@libs/proto';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        privateKey: readFileSync(
          configService.getOrThrow<string>('JWT_PRIVATE_KEY_PATH'),
          'utf8',
        ),
        publicKey: readFileSync(
          configService.getOrThrow<string>('JWT_PUBLIC_KEY_PATH'),
          'utf8',
        ),
        signOptions: {
          algorithm: 'RS256',
          expiresIn: ACCESS_JWT_TTL_SECONDS,
          issuer: 'access',
        },
        verifyOptions: {
          algorithms: ['RS256'],
          issuer: 'access',
        },
      }),
    }),
    ClientsModule.register([
      {
        name: 'PETS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.PETS_GRPC_URL ?? '0.0.0.0:3005',
          package: PETS_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/pets/pets.proto'),
        },
      },
      {
        name: 'CLINIC_SERVİCE',
        transport: Transport.GRPC,
        options: {
          url: process.env.CLINICS_GRPC_URL ?? '0.0.0.0:3003',
          package: CLINICS_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_INTERNAL_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/clinics/clinics.proto'),
        },
      },
    ]),
  ],
  controllers: [AccessController],
  providers: [AccessService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class AccessModule {}
