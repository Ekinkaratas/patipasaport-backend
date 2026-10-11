import { randomUUID } from 'crypto';

export const CLOUD_EVENT_SPEC_VERSION = '1.0';
export const CLOUD_EVENT_CONTENT_TYPE = 'application/cloudevents+json';
export const CLOUD_EVENT_DATA_CONTENT_TYPE = 'application/json';

export const CLOUD_EVENT_SOURCES = {
  MEDICAL_RECORD: '/patipasaport/medical-record',
  AI_SERVICE: '/patipasaport/ai-service',
} as const;

export const DOCUMENT_EVENT_TYPES = {
  UPLOADED: 'com.patipasaport.document.uploaded.v1',
  PROCESSING_STARTED: 'com.patipasaport.document.processing_started.v1',
  ANALYZED: 'com.patipasaport.document.analyzed.v1',
  ANALYSIS_FAILED: 'com.patipasaport.document.analysis_failed.v1',
} as const;

export type DocumentEventType =
  (typeof DOCUMENT_EVENT_TYPES)[keyof typeof DOCUMENT_EVENT_TYPES];

export const DOCUMENT_EVENT_SCHEMAS: Record<DocumentEventType, string> = {
  [DOCUMENT_EVENT_TYPES.UPLOADED]:
    'urn:patipasaport:events:DocumentUploaded:v1',
  [DOCUMENT_EVENT_TYPES.PROCESSING_STARTED]:
    'urn:patipasaport:events:DocumentProcessingStarted:v1',
  [DOCUMENT_EVENT_TYPES.ANALYZED]:
    'urn:patipasaport:events:DocumentAnalyzed:v1',
  [DOCUMENT_EVENT_TYPES.ANALYSIS_FAILED]:
    'urn:patipasaport:events:DocumentAnalysisFailed:v1',
};

export interface CloudEvent<T = unknown> {
  specversion: typeof CLOUD_EVENT_SPEC_VERSION;
  id: string;
  source: string;
  type: DocumentEventType;
  subject: string;
  time: string;
  datacontenttype: typeof CLOUD_EVENT_DATA_CONTENT_TYPE;
  dataschema: string;
  data: T;
}

export interface CreateCloudEventParams<T> {
  type: DocumentEventType;
  source: string;
  subject: string;
  data: T;
  id?: string;
  time?: Date;
}

export function createCloudEvent<T>({
  type,
  source,
  subject,
  data,
  id = randomUUID(),
  time = new Date(),
}: CreateCloudEventParams<T>): CloudEvent<T> {
  return {
    specversion: CLOUD_EVENT_SPEC_VERSION,
    id,
    source,
    type,
    subject,
    time: time.toISOString(),
    datacontenttype: CLOUD_EVENT_DATA_CONTENT_TYPE,
    dataschema: DOCUMENT_EVENT_SCHEMAS[type],
    data,
  };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isDocumentEventType = (value: unknown): value is DocumentEventType =>
  Object.values(DOCUMENT_EVENT_TYPES).includes(value as DocumentEventType);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseCloudEvent(raw: unknown): CloudEvent | null {
  if (!isPlainObject(raw)) return null;

  const {
    specversion,
    id,
    source,
    type,
    subject,
    time,
    datacontenttype,
    dataschema,
    data,
  } = raw;

  if (
    specversion !== CLOUD_EVENT_SPEC_VERSION ||
    !isNonEmptyString(id) ||
    !isNonEmptyString(source) ||
    !isDocumentEventType(type) ||
    !isNonEmptyString(subject) ||
    !isNonEmptyString(time) ||
    Number.isNaN(Date.parse(time)) ||
    datacontenttype !== CLOUD_EVENT_DATA_CONTENT_TYPE ||
    dataschema !== DOCUMENT_EVENT_SCHEMAS[type] ||
    !isPlainObject(data)
  ) {
    return null;
  }

  return {
    specversion,
    id,
    source,
    type,
    subject,
    time,
    datacontenttype,
    dataschema,
    data,
  };
}
