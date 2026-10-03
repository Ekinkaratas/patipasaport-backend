import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TokenExchangeGuard } from '@libs/common';
import { AppController } from './app.controller';
import { ApiAccessModule } from './access/access.module';
import { ApiAuthModule } from './auth/auth.module';
import { ApiClinicsModule } from './clinics/clinics.module';
import { ApiMedicalRecordModule } from './medical-record/medical-record.module';
import { ApiPetsModule } from './pets/pets.module';
import { ApiUsersModule } from './users/users.module';
import { CorrelationMiddleware } from './middleware/correlation.middleware';

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
  providers: [{ provide: APP_GUARD, useClass: TokenExchangeGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
