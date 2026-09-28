import { join } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env') });

const user = process.env.AUTH_DB_USER ?? 'auth_user';
const password = encodeURIComponent(process.env.AUTH_DB_PASSWORD ?? '');
const host = process.env.AUTH_DB_HOST ?? 'localhost';
const port = process.env.AUTH_DB_PORT ?? '5433';
const name = process.env.AUTH_DB_NAME ?? 'auth_db';

export default defineConfig({
  schema: join(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: join(__dirname, 'prisma/migrations'),
  },
  datasource: {
    url: `postgresql://${user}:${password}@${host}:${port}/${name}`,
  },
});
