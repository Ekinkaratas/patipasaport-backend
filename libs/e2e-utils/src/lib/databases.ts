import { Client } from 'pg';
import { DatabaseName, DOCKER_DB_PORTS } from './ports';
import { requireEnv } from './workspace';

const DB_ENV_PREFIX: Record<DatabaseName, string> = {
  access: 'ACCESS',
  auth: 'AUTH',
  clinics: 'CLINICS',
  pets: 'PETS',
  users: 'USERS',
};

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function databaseConfig(name: DatabaseName): DatabaseConfig {
  const prefix = DB_ENV_PREFIX[name];
  return {
    host: '127.0.0.1',
    port: DOCKER_DB_PORTS[name],
    user: requireEnv(`${prefix}_DB_USER`),
    password: requireEnv(`${prefix}_DB_PASSWORD`),
    database: requireEnv(`${prefix}_DB_NAME`),
  };
}

export async function connectDatabase(name: DatabaseName): Promise<Client> {
  const client = new Client(databaseConfig(name));
  await client.connect();
  return client;
}
