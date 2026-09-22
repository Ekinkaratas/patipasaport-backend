import { LogAction } from './log-action.enum';

export interface LogPayload {
  correlationId: string;
  userId: string | null;
  service: string;
  method: string;
  action: LogAction;
  identifier?: string | null;
  errorCode?: string;
  timestamp: string;
}
