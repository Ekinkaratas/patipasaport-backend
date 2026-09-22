import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CORRELATION_ID_HEADER, runWithCorrelationId } from '@libs/common';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string) || randomUUID();

    runWithCorrelationId(correlationId, () => {
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
      next();
    });
  }
}
