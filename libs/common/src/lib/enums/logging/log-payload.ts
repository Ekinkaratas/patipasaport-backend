import { LogAction } from './log-action.enum';

export interface LogPayload {
  requestId: string | null;
  userId: string | null;
  service: string;
  method: string;
  action: LogAction;
  identifier?: string | null;
  errorCode?: string;
  timestamp: string;
}
