import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GrpcJwtGuard } from '@libs/common';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from './redis/redis.module';
import { JwtModule } from '@nestjs/jwt';
import { readFileSync } from 'fs';
import { ACCESS_JWT_TTL_SECONDS } from './access.constants';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AccessController],
  providers: [AccessService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class AccessModule {}
