import { join } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env') });

const user = process.env.ACCESS_DB_USER ?? 'access_user';
const password = encodeURIComponent(process.env.ACCESS_DB_PASSWORD ?? '');
const host = process.env.ACCESS_DB_HOST ?? 'localhost';
const port = process.env.ACCESS_DB_PORT ?? '5436';
const name = process.env.ACCESS_DB_NAME ?? 'access_db';

export default defineConfig({
  schema: join(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: join(__dirname, 'prisma/migrations'),
  },
  datasource: {
    url: `postgresql://${user}:${password}@${host}:${port}/${name}`,
  },
});
