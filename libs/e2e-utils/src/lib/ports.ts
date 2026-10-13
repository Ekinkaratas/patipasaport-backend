export type ServiceName =
  | 'gateway'
  | 'access'
  | 'auth'
  | 'clinics'
  | 'medical_record'
  | 'pets'
  | 'users';

export type GrpcServiceName =
  | 'access'
  | 'auth'
  | 'clinics'
  | 'medical_record'
  | 'pets'
  | 'users';

export type DatabaseName =
  | 'access'
  | 'auth'
  | 'clinics'
  | 'medical_record'
  | 'pets'
  | 'users';

export const DOCKER_GRPC_PORTS: Record<GrpcServiceName, number> = {
  access: 3001,
  auth: 3002,
  clinics: 3003,
  medical_record: 3004,
  pets: 3005,
  users: 3006,
};

export const E2E_PORTS: Record<ServiceName, number> = {
  gateway: 4000,
  access: 4001,
  auth: 4002,
  clinics: 4003,
  medical_record: 4004,
  pets: 4005,
  users: 4006,
};

export const DOCKER_DB_PORTS: Record<DatabaseName, number> = {
  auth: 5433,
  users: 5434,
  clinics: 5435,
  access: 5436,
  medical_record: 5437,
  pets: 5438,
};

export const DOCKER_REDIS_PORTS = {
  access: 6379,
  auth: 6380,
} as const;

export const DOCKER_S3_PORT = 8333;

export const DOCKER_RABBITMQ_PORT = 5672;
