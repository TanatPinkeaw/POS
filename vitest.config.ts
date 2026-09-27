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
    // Integration tests share one PostgreSQL database. Running files in
    // parallel would let one suite's TRUNCATE land in the middle of another's
    // row-locking assertions.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
