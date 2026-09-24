import { Module } from '@nestjs/common';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [PetsController],
  providers: [PetsService],
})
export class PetsModule {}
