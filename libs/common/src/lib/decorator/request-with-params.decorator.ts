import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export type RequestSource = 'body' | 'query';

export const RequestWithParams = createParamDecorator(
  (source: RequestSource, ctx: ExecutionContext): Record<string, unknown> => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return { ...(request[source] ?? {}), ...request.params };
  },
);
