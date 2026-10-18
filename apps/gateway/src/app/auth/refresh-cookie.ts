import {
  CallHandler,
  ExecutionContext,
  Injectable,
  mixin,
  NestInterceptor,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import { CookieOptions, Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { BaseResponse, ResponseMessages } from '@libs/common';
import { auth } from '@libs/proto';

export const REFRESH_COOKIE_NAME = 'pp_refresh';

const DEFAULT_REFRESH_COOKIE_PATH = '/api/auth';
const WEB_CLIENT_TYPE = '1';

export type WebTokenResponse = Omit<auth.TokenResponse, 'refreshToken'>;

export function parseRefreshCookiePath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_REFRESH_COOKIE_PATH;
  if (!/^\/[^\s;,]*$/.test(value)) {
    throw new Error(
      `REFRESH_COOKIE_PATH geçersiz: "${raw}" (/ ile başlamalı, ör. /api/auth)`,
    );
  }
  return value;
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

@Injectable()
export class RefreshCookieService {
  private readonly path = parseRefreshCookiePath(
    process.env.REFRESH_COOKIE_PATH,
  );

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: this.path,
    };
  }

  read(request: Request): string | undefined {
    return readCookie(request.headers.cookie, REFRESH_COOKIE_NAME);
  }

  set(response: Response, token: string, maxAgeSeconds: number): void {
    response.cookie(
      REFRESH_COOKIE_NAME,
      token,
      maxAgeSeconds > 0
        ? { ...this.options(), maxAge: maxAgeSeconds * 1000 }
        : this.options(),
    );
  }

  clear(response: Response): void {
    response.clearCookie(REFRESH_COOKIE_NAME, this.options());
  }
}

export interface RefreshCookieMode {
  read: boolean;
  write: 'set' | 'clear';
}

export function RefreshCookie(mode: RefreshCookieMode): Type<NestInterceptor> {
  @Injectable()
  class RefreshCookieInterceptor implements NestInterceptor {
    constructor(private readonly cookies: RefreshCookieService) {}

    intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Observable<unknown> {
      const http = context.switchToHttp();
      const request = http.getRequest<Request>();
      const response = http.getResponse<Response>();
      const token = mode.read ? this.cookies.read(request) : undefined;
      const web =
        request.headers['x-client-type'] === WEB_CLIENT_TYPE ||
        token !== undefined;

      if (!web) return next.handle();

      if (mode.write === 'clear') this.cookies.clear(response);
      if (mode.read) {
        if (token === undefined) {
          throw new UnauthorizedException(ResponseMessages.UNAUTH);
        }
        request.body = { ...(request.body ?? {}), refreshToken: token };
      }
      if (mode.write === 'clear') return next.handle();

      return next
        .handle()
        .pipe(
          map((result) =>
            this.moveTokenToCookie(
              result as BaseResponse<auth.TokenResponse>,
              response,
            ),
          ),
        );
    }

    private moveTokenToCookie(
      result: BaseResponse<auth.TokenResponse>,
      response: Response,
    ): BaseResponse<WebTokenResponse> {
      const { refreshToken, ...data } = result.data;
      if (refreshToken) {
        this.cookies.set(response, refreshToken, data.refreshExpiresIn);
      }
      return new BaseResponse(
        data,
        result.message,
        result.success,
        result.correlationId,
      );
    }
  }

  return mixin(RefreshCookieInterceptor);
}
