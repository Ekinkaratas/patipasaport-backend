import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AUTH_PACKAGE_NAME } from '@libs/proto';
import { join } from 'path';
import { ApiAuthService } from './auth.service';
import { ApiAuthController } from './auth.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: '0.0.0.0:3002',
          package: AUTH_PACKAGE_NAME,
          protoPath: join(__dirname, 'proto/auth/auth.proto'),
        },
      },
    ]),
  ],
  controllers: [ApiAuthController],
  providers: [ApiAuthService],
})
export class ApiAuthModule {}
