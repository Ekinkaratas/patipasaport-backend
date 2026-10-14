import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PETS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  requiredEnv,
} from '@libs/common';
import { ApiPetsService } from './pets.service';
import { ApiPetsController } from './pets.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'PETS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: requiredEnv('PETS_GRPC_URL'),
          package: PETS_PACKAGE_NAME,
          loader: {
            defaults: true,
            arrays: true,
          },
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
              grpcAuthClientInterceptor,
              createGrpcDeadlineInterceptor(GRPC_GATEWAY_TIMEOUT_MS),
            ],
          },
          protoPath: join(__dirname, 'proto/pets/pets.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiPetsController],
  providers: [ApiPetsService],
})
export class ApiPetsModule {}
