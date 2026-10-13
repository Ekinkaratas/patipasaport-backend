import {
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { Response } from 'express';

export type RateLimitScope = 'auth' | 'upload';

export interface RateLimitConfig {
  windowSeconds: number;
  global: number;
  auth: number;
  upload: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  windowSeconds: 60,
  global: 100,
  auth: 10,
  upload: 20,
};

const RATE_LIMIT_SCOPE_KEY = 'rateLimitScope';

export const RateLimit = (scope: RateLimitScope) =>
  SetMetadata(RATE_LIMIT_SCOPE_KEY, scope);

const logger = new Logger('RateLimit');

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn(
      `${name} geçersiz ("${raw}") — varsayılan ${fallback} kullanılıyor`,
    );
    return fallback;
  }
  return parsed;
}

export function readRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  return {
    windowSeconds: readPositiveInt(
      env,
      'RATE_LIMIT_WINDOW_SECONDS',
      DEFAULT_RATE_LIMITS.windowSeconds,
    ),
    global: readPositiveInt(
      env,
      'RATE_LIMIT_GLOBAL',
      DEFAULT_RATE_LIMITS.global,
    ),
    auth: readPositiveInt(env, 'RATE_LIMIT_AUTH', DEFAULT_RATE_LIMITS.auth),
    upload: readPositiveInt(
      env,
      'RATE_LIMIT_UPLOAD',
      DEFAULT_RATE_LIMITS.upload,
    ),
  };
}

const reflector = new Reflector();

const scopeOf = (context: ExecutionContext): RateLimitScope | undefined =>
  reflector.get<RateLimitScope | undefined>(
    RATE_LIMIT_SCOPE_KEY,
    context.getHandler(),
  );

export function createThrottlerOptions(
  config: RateLimitConfig,
): ThrottlerModuleOptions {
  const ttl = config.windowSeconds * 1000;
  return {
    generateKey: (_context, tracker, throttlerName) =>
      `${throttlerName}:${tracker}`,
    throttlers: [
      { name: 'default', ttl, limit: config.global },
      {
        name: 'auth',
        ttl,
        limit: config.auth,
        skipIf: (context) => scopeOf(context) !== 'auth',
      },
      {
        name: 'upload',
        ttl,
        limit: config.upload,
        skipIf: (context) => scopeOf(context) !== 'upload',
      },
    ],
  };
}

@Injectable()
export class GatewayThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(throttlerLimitDetail.timeToBlockExpire));
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
