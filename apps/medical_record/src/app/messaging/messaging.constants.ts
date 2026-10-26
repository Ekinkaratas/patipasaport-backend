export const EVENTS_EXCHANGE = 'patipasaport.events';
export const DEAD_LETTER_EXCHANGE = 'patipasaport.events.dlx';

export const AI_UPLOADED_QUEUE = 'ai-service.document-uploaded';
export const DOCUMENT_EVENTS_QUEUE = 'medical-record.document-events';
export const AI_LAB_EXPLANATION_QUEUE = 'ai-service.lab-explanation-requested';
export const LAB_EXPLANATION_EVENTS_QUEUE =
  'medical-record.lab-explanation-events';
export const RETRY_QUEUE_SUFFIX = '.retry';
export const DEAD_LETTER_QUEUE_SUFFIX = '.dlq';

export const RETRY_DELAY_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_COUNT_HEADER = 'x-retry-count';
export const CONSUMER_PREFETCH = 10;
export const PUBLISH_TIMEOUT_MS = 10_000;

export const OUTBOX_POLL_INTERVAL_MS = 1_000;
export const OUTBOX_BATCH_SIZE = 50;
export const OUTBOX_LEASE_SECONDS = 60;
export const OUTBOX_MAX_BACKOFF_SECONDS = 300;
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 500;

export const MODEL_VERSION_MAX_LENGTH = 64;
export const FAILURE_REASON_MAX_LENGTH = 64;
export const INVALID_AI_OUTPUT = 'INVALID_AI_OUTPUT';
