import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoginAttemptService } from './login-attempt.service';
import { RedisService } from './redis.service';

@Module({
  imports: [ConfigModule],
  providers: [RedisService, LoginAttemptService],
  exports: [RedisService, LoginAttemptService],
})
export class RedisModule {}
