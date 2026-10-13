import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { applyHttpSecurity } from './app/security/http-security';
import {
  createWinstonLogger,
  HttpsExceptionFilter,
  TrimPipe,
} from '@libs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: createWinstonLogger('gateway'),
  });

  applyHttpSecurity(app);
  app.useGlobalPipes(
    new TrimPipe(),
    new ValidationPipe({
      whitelist: true,
      transform: true,
      stopAtFirstError: true,
      validateCustomDecorators: true,
    }),
  );
  app.useGlobalFilters(new HttpsExceptionFilter());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}`);
}

bootstrap();
