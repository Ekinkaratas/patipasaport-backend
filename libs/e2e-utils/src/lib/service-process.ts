import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { connect } from 'net';
import { resolve } from 'path';
import { databaseConfig } from './databases';
import {
  DatabaseName,
  DOCKER_DB_PORTS,
  DOCKER_GRPC_PORTS,
  DOCKER_RABBITMQ_PORT,
  DOCKER_REDIS_PORTS,
  DOCKER_S3_PORT,
  E2E_PORTS,
  GrpcServiceName,
  ServiceName,
} from './ports';
import { requireEnv, rootEnv, WORKSPACE_ROOT } from './workspace';

export interface RunningService {
  name: ServiceName;
  port: number;
  logFile: string;
  stop(): Promise<void>;
}

const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_DIR = resolve(WORKSPACE_ROOT, 'tmp/e2e-logs');
const E2E_RATE_LIMIT = '100000';

const grpcUrl = (service: GrpcServiceName): string =>
  `127.0.0.1:${DOCKER_GRPC_PORTS[service]}`;

const jwtPublicKeyPath = (): string =>
  resolve(WORKSPACE_ROOT, 'access_jwt_public.pem');

function databaseEnv(name: DatabaseName): Record<string, string> {
  const config = databaseConfig(name);
  return {
    DB_HOST: config.host,
    DB_PORT: String(config.port),
    DB_USER: config.user,
    DB_PASSWORD: config.password,
    DB_NAME: config.database,
  };
}

function serviceEnv(name: ServiceName): Record<string, string> {
  switch (name) {
    case 'gateway':
      return {
        ACCESS_GRPC_URL: grpcUrl('access'),
        AUTH_GRPC_URL: grpcUrl('auth'),
        CLINICS_GRPC_URL: grpcUrl('clinics'),
        MEDICAL_RECORD_GRPC_URL: grpcUrl('medical_record'),
        PETS_GRPC_URL: grpcUrl('pets'),
        USERS_GRPC_URL: grpcUrl('users'),
        S3_ENDPOINT: `http://127.0.0.1:${DOCKER_S3_PORT}`,
        S3_BUCKET: rootEnv()['S3_BUCKET'] || 'medical-documents',
        S3_ACCESS_KEY: requireEnv('S3_GATEWAY_ACCESS_KEY'),
        S3_SECRET_KEY: requireEnv('S3_GATEWAY_SECRET_KEY'),
        CORS_ORIGINS: '',
        RATE_LIMIT_WINDOW_SECONDS: '60',
        RATE_LIMIT_GLOBAL: E2E_RATE_LIMIT,
        RATE_LIMIT_AUTH: E2E_RATE_LIMIT,
        RATE_LIMIT_UPLOAD: E2E_RATE_LIMIT,
      };
    case 'access':
      return {
        ...databaseEnv('access'),
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: String(DOCKER_REDIS_PORTS.access),
        REDIS_PASSWORD: requireEnv('REDIS_PASSWORD'),
        JWT_PRIVATE_KEY_PATH: resolve(WORKSPACE_ROOT, 'access_jwt_private.pem'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        AUTH_GRPC_URL: grpcUrl('auth'),
        CLINICS_GRPC_URL: grpcUrl('clinics'),
        PETS_GRPC_URL: grpcUrl('pets'),
      };
    case 'auth':
      return {
        ...databaseEnv('auth'),
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: String(DOCKER_REDIS_PORTS.auth),
        REDIS_PASSWORD: requireEnv('AUTH_REDIS_PASSWORD'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        ACCESS_GRPC_URL: grpcUrl('access'),
        USERS_GRPC_URL: grpcUrl('users'),
      };
    case 'clinics':
      return {
        ...databaseEnv('clinics'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        AUTH_GRPC_URL: grpcUrl('auth'),
        MEDICAL_RECORD_GRPC_URL: grpcUrl('medical_record'),
        PETS_GRPC_URL: grpcUrl('pets'),
        USERS_GRPC_URL: grpcUrl('users'),
      };
    case 'pets':
      return {
        ...databaseEnv('pets'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        ACCESS_GRPC_URL: grpcUrl('access'),
        PETS_CHIP_ENCRYPTION_KEY: requireEnv('PETS_CHIP_ENCRYPTION_KEY'),
        PETS_CHIP_INDEX_KEY: requireEnv('PETS_CHIP_INDEX_KEY'),
      };
    case 'medical_record':
      return {
        ...databaseEnv('medical_record'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        ACCESS_GRPC_URL: grpcUrl('access'),
        PETS_GRPC_URL: grpcUrl('pets'),
        RABBITMQ_HOST: '127.0.0.1',
        RABBITMQ_PORT: String(DOCKER_RABBITMQ_PORT),
        RABBITMQ_USER: requireEnv('RABBITMQ_USER'),
        RABBITMQ_PASSWORD: requireEnv('RABBITMQ_PASSWORD'),
      };
    case 'users':
      return {
        ...databaseEnv('users'),
        JWT_PUBLIC_KEY_PATH: jwtPublicKeyPath(),
        ACCESS_GRPC_URL: grpcUrl('access'),
      };
  }
}

function dockerDependencies(name: ServiceName): Record<string, number> {
  const grpc = (...services: GrpcServiceName[]) =>
    Object.fromEntries(
      services.map((service) => [service, DOCKER_GRPC_PORTS[service]]),
    );
  switch (name) {
    case 'gateway':
      return {
        ...grpc('access', 'auth', 'clinics', 'medical_record', 'pets', 'users'),
        seaweedfs: DOCKER_S3_PORT,
      };
    case 'access':
      return {
        'postgres-access': DOCKER_DB_PORTS.access,
        'redis-access': DOCKER_REDIS_PORTS.access,
        ...grpc('auth', 'clinics', 'pets'),
      };
    case 'auth':
      return {
        'postgres-auth': DOCKER_DB_PORTS.auth,
        'redis-auth': DOCKER_REDIS_PORTS.auth,
        ...grpc('access', 'users'),
      };
    case 'clinics':
      return {
        'postgres-clinics': DOCKER_DB_PORTS.clinics,
        ...grpc('access', 'auth', 'medical_record', 'pets', 'users'),
      };
    case 'medical_record':
      return {
        'postgres-medical-record': DOCKER_DB_PORTS.medical_record,
        rabbitmq: DOCKER_RABBITMQ_PORT,
        ...grpc('access', 'pets'),
      };
    case 'pets':
      return {
        'postgres-pets': DOCKER_DB_PORTS.pets,
        ...grpc('access', 'clinics'),
      };
    case 'users':
      return {
        'postgres-users': DOCKER_DB_PORTS.users,
        ...grpc('access', 'clinics', 'pets'),
      };
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

const sleep = (ms: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function assertDockerDependencies(name: ServiceName): Promise<void> {
  const missing: string[] = [];
  for (const [dependency, port] of Object.entries(dockerDependencies(name))) {
    if (!(await canConnect(port))) {
      missing.push(`${dependency} (127.0.0.1:${port})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${name} e2e için Docker'da çalışması gereken bağımlılıklara ulaşılamadı: ${missing.join(', ')}`,
    );
  }
}

async function waitUntilListening(
  child: ChildProcess,
  port: number,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`süreç başlarken kapandı (exitCode=${child.exitCode})`);
    }
    if (await canConnect(port)) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`${STARTUP_TIMEOUT_MS} ms içinde port açılmadı`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
}

const logTail = (logFile: string): string =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n')
    : '';

export async function startService(
  name: ServiceName,
  envOverrides: Record<string, string> = {},
): Promise<RunningService> {
  const port = E2E_PORTS[name];
  const mainFile = resolve(WORKSPACE_ROOT, `dist/apps/${name}/main.js`);

  if (!existsSync(mainFile)) {
    throw new Error(`${mainFile} yok; önce "${name}:build" çalışmalı`);
  }
  if (await canConnect(port)) {
    throw new Error(
      `${port} portu zaten kullanımda; e2e başka bir süreci kapatmaz, portu boşaltıp tekrar dene`,
    );
  }
  await assertDockerDependencies(name);

  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = resolve(LOG_DIR, `${name}.log`);
  const log = createWriteStream(logFile, { flags: 'w' });

  const child = spawn(process.execPath, [mainFile], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      ...serviceEnv(name),
      ...envOverrides,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  try {
    await waitUntilListening(child, port);
  } catch (e) {
    await stopChild(child);
    log.end();
    throw new Error(
      `${name} ${port} portunda başlatılamadı: ${(e as Error).message}\n--- ${logFile} ---\n${logTail(logFile)}`,
    );
  }

  return {
    name,
    port,
    logFile,
    stop: async () => {
      await stopChild(child);
      log.end();
    },
  };
}
