import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  LogAction,
  LogActionMap,
  LogLevel,
  LogLevelMap,
  ResponseMessages,
} from '../enums';

/**
 * Reddedilen isteği loglayıp RpcException fırlatır.
 *
 * Seviye koddan türetilir (ResponseMessages -> LogAction -> LogLevel).
 * level parametresi yalnızca çağıranın kodun taşımadığı bir bağlamı
 * bildiği durumlar içindir örnek olarak INVALID_TOKEN normalde rutindir ancak
 * clientType uyuşmazlığından geliyorsa bu durum token'ın çalınmış olma olsaılığını doğurur ve bu bir şüphesidir bu yüzden .
 *
 * reason yalnızca açıklama alanıdır - lient dan gelen text buraya yazılmaz
 */
export function rejectRpc(
  logger: Logger,
  code: ResponseMessages,
  reason: string,
  level?: LogLevel,
): never {
  const action = LogActionMap[code] ?? LogAction.REQUEST_FAILED;
  const resolved = level ?? LogLevelMap[action];

  logger[resolved](`Reddedildi (${code}): ${reason}`);
  throw new RpcException(code);
}
