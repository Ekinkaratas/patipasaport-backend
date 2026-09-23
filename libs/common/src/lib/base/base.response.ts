export class BaseResponse<T> {
  data: T;
  message: string;
  success: boolean;
  correlationId?: string;

  constructor(
    data: T,
    message: string,
    success: boolean,
    correlationId?: string,
  ) {
    this.data = data;
    this.message = message;
    this.success = success;
    if (correlationId) this.correlationId = correlationId;
  }
}
