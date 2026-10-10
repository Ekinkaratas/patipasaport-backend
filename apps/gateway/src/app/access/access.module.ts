import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ACCESS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
} from '@libs/common';
import { ApiAccessController } from './access.controller';
import { ApiAccessService } from './access.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'ACCESS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.ACCESS_GRPC_URL ?? '0.0.0.0:3001',
          package: ACCESS_PACKAGE_NAME,
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
            loader: {
              defaults: true,
              arrays: true,
            },
          },
          protoPath: join(__dirname, 'proto/access/access.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiAccessController],
  providers: [ApiAccessService],
  exports: [ClientsModule],
})
export class ApiAccessModule {}
