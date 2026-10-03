import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Swaps DATABASE_URL to the test database before any app module is loaded.
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one PostgreSQL database, and each file's
    // `resetDatabase()` empties it before its first test. Running files in
    // parallel would let one suite's empty land in the middle of another's
    // row-locking assertions, so the files stay serial. (Speeding this up means
    // giving each worker its own schema, not relaxing this flag.)
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
