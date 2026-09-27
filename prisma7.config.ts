// Prisma 7 configuration. The datasource URL lives here rather than in
// schema.prisma, and `.env` is loaded explicitly with Node's built-in loader
// (Prisma 7 no longer reads .env on its own).
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

// Only seed from .env when the caller has not already supplied a URL.
// `loadEnvFile` overwrites, which would clobber the DATABASE_URL that
// `scripts/prepare-test-db.ts` passes in to migrate the test database.
if (!process.env.DATABASE_URL && existsSync('.env')) {
  loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
