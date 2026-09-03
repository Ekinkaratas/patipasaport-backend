import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { USERS_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import { ApiUserService } from './users.service';
import { ApiUserController } from './users.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'USERS_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: '0.0.0.0:3006',
          package: USERS_PACKAGE_NAME,
          protoPath: join(__dirname, 'proto/users/users.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiUserController],
  providers: [ApiUserService],
})
export class ApiUsersModule {}
