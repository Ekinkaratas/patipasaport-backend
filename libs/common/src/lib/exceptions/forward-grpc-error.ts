import { Logger } from '@nestjs/common';
import { rejectRpc } from './reject-rpc';
import { ResponseMessages } from '../enums';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';

// --- Amaç: dış servisden gelen hatayı istemciye güvenli şekilde aktarmak ---
export function forwardGrpcError(
  logger: Logger,
  error: unknown,
  context: string,
  allowed: readonly ResponseMessages[] = [],
): never {
  const { code, details } = (error ?? {}) as {
    code?: unknown;
    details?: unknown;
  };

  if (
    typeof details === 'string' &&
    allowed.includes(details as ResponseMessages)
  ) {
    throw new RpcException(details);
  }

  if (code === status.UNAVAILABLE || code === status.DEADLINE_EXCEEDED) {
    rejectRpc(
      logger,
      ResponseMessages.SERVICE_UNAVAILABLE,
      `${context}: servise ulaşılamadı (code=${String(code)})`,
    );
  }

  rejectRpc(
    logger,
    ResponseMessages.INTERNAL_SERVER_ERROR,
    `${context}: beklenmeyen yanıt (code=${String(code)}, details=${String(details)})`,
  );
}
