import { join } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env') });

const user = process.env.MEDICAL_DB_USER ?? 'medical_user';
const password = encodeURIComponent(process.env.MEDICAL_DB_PASSWORD ?? '');
const host = process.env.MEDICAL_DB_HOST ?? 'localhost';
const port = process.env.MEDICAL_DB_PORT ?? '5437';
const name = process.env.MEDICAL_DB_NAME ?? 'medical_db';

export default defineConfig({
  schema: join(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: join(__dirname, 'prisma/migrations'),
  },
  datasource: {
    url: `postgresql://${user}:${password}@${host}:${port}/${name}`,
  },
});
