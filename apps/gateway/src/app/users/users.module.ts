import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { USERS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import {
  createGrpcDeadlineInterceptor,
  GRPC_GATEWAY_TIMEOUT_MS,
  grpcAuthClientInterceptor,
  grpcCorrelationClientInterceptor,
  requiredEnv,
} from '@libs/common';
import { ApiUserService } from './users.service';
import { ApiUserController } from './users.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'USERS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: requiredEnv('USERS_GRPC_URL'),
          package: USERS_PACKAGE_NAME,
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
          protoPath: join(__dirname, 'proto/users/users.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiUserController],
  providers: [ApiUserService],
})
export class ApiUsersModule {}
