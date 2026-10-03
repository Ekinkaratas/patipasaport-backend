import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GrpcJwtGuard } from '@libs/common';
import { MedicalRecordController } from './medical-record.controller';
import { MedicalRecordService } from './medical-record.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [MedicalRecordController],
  providers: [
    MedicalRecordService,
    { provide: APP_GUARD, useClass: GrpcJwtGuard },
  ],
})
export class MedicalRecordModule {}
