import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  ServiceClientConstructor,
  ServiceError,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { resolve } from 'path';
import { GrpcServiceName } from './ports';
import { WORKSPACE_ROOT } from './workspace';

export type GrpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; details: string };

const PROTO_ROOT = resolve(WORKSPACE_ROOT, 'libs/proto/src/lib');

const SERVICE_DEFINITIONS: Record<
  GrpcServiceName,
  { file: string; pkg: string; service: string }
> = {
  access: { file: 'access/access.proto', pkg: 'access', service: 'AccessService' },
  auth: { file: 'auth/auth.proto', pkg: 'auth', service: 'AuthService' },
  clinics: {
    file: 'clinics/clinics.proto',
    pkg: 'clinics',
    service: 'ClinicsService',
  },
  medical_record: {
    file: 'medical_record/medical_record.proto',
    pkg: 'medical_record',
    service: 'MedicalRecordService',
  },
  pets: { file: 'pets/pets.proto', pkg: 'pets', service: 'PetsService' },
  users: { file: 'users/users.proto', pkg: 'users', service: 'UsersService' },
};

export function grpcClient(service: GrpcServiceName, port: number): Client {
  const definition = SERVICE_DEFINITIONS[service];
  const packageDefinition = loadSync(resolve(PROTO_ROOT, definition.file), {
    defaults: true,
    arrays: true,
  });
  const grpcPackage = loadPackageDefinition(packageDefinition)[
    definition.pkg
  ] as Record<string, ServiceClientConstructor>;
  const Constructor = grpcPackage[definition.service];
  return new Constructor(`127.0.0.1:${port}`, credentials.createInsecure());
}

type UnaryMethod = (
  request: object,
  metadata: Metadata,
  options: { deadline: number },
  callback: (error: ServiceError | null, value: unknown) => void,
) => void;

export function callGrpc<T>(
  client: Client,
  method: string,
  request: object,
  token?: string,
  timeoutMs = 15_000,
): Promise<GrpcResult<T>> {
  const metadata = new Metadata();
  if (token) {
    metadata.set('authorization', `Bearer ${token}`);
  }
  const unary = (client as unknown as Record<string, UnaryMethod>)[method];
  if (typeof unary !== 'function') {
    throw new Error(`gRPC istemcisinde ${method} metodu yok`);
  }
  return new Promise((resolvePromise) => {
    unary.call(
      client,
      request,
      metadata,
      { deadline: Date.now() + timeoutMs },
      (error, value) => {
        resolvePromise(
          error
            ? { ok: false, code: status[error.code], details: error.details }
            : { ok: true, value: value as T },
        );
      },
    );
  });
}

export function expectOk<T>(result: GrpcResult<T>, context: string): T {
  if (!result.ok) {
    throw new Error(`${context}: ${result.code}/${result.details}`);
  }
  return result.value;
}
