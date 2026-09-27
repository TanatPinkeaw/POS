/**
 * Applies every migration to the integration-test database.
 *
 * A script rather than an npm one-liner because the URL has to be swapped and
 * `cross-env` cannot expand `$TEST_DATABASE_URL` portably on Windows.
 *
 * Run with: npm run db:test:prepare
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set. Add it to .env.');
  process.exit(1);
}

const databaseName = new URL(testUrl).pathname.replace(/^\//, '');
if (!/test/i.test(databaseName)) {
  console.error(
    `Refusing to migrate "${databaseName}": the database name must contain "test".`,
  );
  process.exit(1);
}

console.log(`Applying migrations to ${databaseName}…`);

// A single command string with `shell: true`: spawnSync cannot execute a `.cmd`
// shim (npx.cmd) directly on Windows, and the failure is silent unless
// `result.error` is read. The URL is quoted, and comes from .env rather than
// from user input, so there is nothing here to interpolate.
const result = spawnSync('npx prisma migrate deploy', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
});

if (result.error) {
  console.error('Could not run prisma migrate deploy:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`prisma migrate deploy exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log('Test database is up to date.');
