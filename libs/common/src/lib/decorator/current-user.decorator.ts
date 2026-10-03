import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { AuthUser, getAuthUser } from '../guards/auth-user';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => {
    const user = getAuthUser(ctx.switchToRpc().getContext<Metadata>());
    if (!user) {
      throw new Error(
        'CurrentUser: doğrulanmış kullanıcı yok (uç @Public mi?)',
      );
    }
    return user;
  },
);
