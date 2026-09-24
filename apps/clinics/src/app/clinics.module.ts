import { Module } from '@nestjs/common';
import { ClinicsController } from './clinics.controller';
import { ClinicsService } from './clinics.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [ClinicsController],
  providers: [ClinicsService],
})
export class ClinicsModule {}
