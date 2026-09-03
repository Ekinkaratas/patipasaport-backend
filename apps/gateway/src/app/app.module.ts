import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ApiAccessModule } from './access/access.module';
import { ApiAuthModule } from './auth/auth.module';
import { ApiClinicsModule } from './clinics/clinics.module';
import { ApiMedicalRecordModule } from './medical-record/medical-record.module';
import { ApiPetsModule } from './pets/pets.module';
import { ApiUsersModule } from './users/users.module';

@Module({
  imports: [
    ApiAccessModule,
    ApiAuthModule,
    ApiClinicsModule,
    ApiMedicalRecordModule,
    ApiPetsModule,
    ApiUsersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
