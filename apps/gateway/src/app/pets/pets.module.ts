import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PETS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcCorrelationClientInterceptor,
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
          url: process.env.PETS_GRPC_URL ?? '0.0.0.0:3005',
          package: PETS_PACKAGE_NAME,
          channelOptions: {
            interceptors: [
              grpcCorrelationClientInterceptor,
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
