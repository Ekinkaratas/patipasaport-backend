import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GrpcJwtGuard } from '@libs/common';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [PetsController],
  providers: [PetsService, { provide: APP_GUARD, useClass: GrpcJwtGuard }],
})
export class PetsModule {}
