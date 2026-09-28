import { ValidationError, ValidationPipe } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ResponseMessages } from '../enums';

/**
 * gRPC servisleri için global ValidationPipe.
 *
 * Yalnızca handler parametresi `@Payload() dto: XxxDto` gibi class-validator dekoratörlü bir sınıfla tiplendiğinde çalışır.
 *
 * Hata, DTO'daki getValidationMessage çıktısıyla RpcException olarak fırlar;
 */
export function createGrpcValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    stopAtFirstError: true,
    exceptionFactory: (errors) =>
      new RpcException(
        findFirstMessage(errors) ?? ResponseMessages.VALIDATION_ERROR,
      ),
  });
}

function findFirstMessage(errors: ValidationError[]): string | undefined {
  for (const error of errors) {
    const message = Object.values(error.constraints ?? {})[0];
    if (message) return message;

    const nested = findFirstMessage(error.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}
