import { Module } from '@nestjs/common';
import { MedicalRecordController } from './medical-record.controller';
import { MedicalRecordService } from './medical-record.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [MedicalRecordController],
  providers: [MedicalRecordService],
})
export class MedicalRecordModule {}
