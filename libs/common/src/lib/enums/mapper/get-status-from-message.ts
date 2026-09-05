import { HttpStatus } from '@nestjs/common';
import { ResponseStatusMap } from './response-status.map';
import { ResponseMessages } from '../messages/ResponseMessages.enum';

export function getStatusFromMessage(
  message: string | null | undefined,
): HttpStatus {
  if (message && message in ResponseStatusMap) {
    return ResponseStatusMap[message as ResponseMessages];
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
