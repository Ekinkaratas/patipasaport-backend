import { join } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env') });

const user = process.env.USERS_DB_USER ?? 'users_user';
const password = encodeURIComponent(process.env.USERS_DB_PASSWORD ?? '');
const host = process.env.USERS_DB_HOST ?? 'localhost';
const port = process.env.USERS_DB_PORT ?? '5434';
const name = process.env.USERS_DB_NAME ?? 'users_db';

export default defineConfig({
  schema: join(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: join(__dirname, 'prisma/migrations'),
  },
  datasource: {
    url: `postgresql://${user}:${password}@${host}:${port}/${name}`,
  },
});
