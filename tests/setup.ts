/**
 * Test bootstrap.
 *
 * Runs before any test file is imported, which is the only moment at which the
 * database URL can be swapped: `src/lib/db.ts` reads `DATABASE_URL` once, when
 * its module is first evaluated.
 *
 * The guard against a non-test database name is deliberate. Integration tests
 * truncate tables, and a mis-set variable must not be able to wipe the shop.
 */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env and add a separate test database.',
  );
}

const databaseName = new URL(testUrl).pathname.replace(/^\//, '');
if (!/test/i.test(databaseName)) {
  throw new Error(
    `Refusing to run destructive tests against database "${databaseName}": the name must contain "test".`,
  );
}

process.env.DATABASE_URL = testUrl;
process.env.AUTH_SECRET ??= 'test-secret-that-is-definitely-long-enough-1234567890';

// Next types NODE_ENV as read-only, but a test run must not execute production
// code paths (db.ts, for one, logs differently per environment).
(process.env as Record<string, string>).NODE_ENV = 'test';
