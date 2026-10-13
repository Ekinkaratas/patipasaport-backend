import { INestApplication } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Client-Type',
  'X-Correlation-Id',
];

const CORS_EXPOSED_HEADERS = ['Retry-After'];

const isOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

export function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const invalid = origins.find((origin) => !isOrigin(origin));
  if (invalid !== undefined) {
    throw new Error(
      `CORS_ORIGINS geçersiz origin içeriyor: "${invalid}" (beklenen biçim: https://app.example.com)`,
    );
  }
  return origins;
}

export function applyHttpSecurity(app: INestApplication): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      xFrameOptions: { action: 'deny' },
    }),
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: parseCorsOrigins(process.env.CORS_ORIGINS),
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
  });
}
