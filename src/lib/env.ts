/**
 * Process bootstrap. Must be imported before anything that reads configuration
 * or serialises a database row.
 */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Prisma 7 no longer loads `.env` on its own, and Next only does so inside its
// own bundler. The custom server and the seed script are outside both, so they
// load it here. Real environment variables always win.
if (!process.env.DATABASE_URL && existsSync('.env')) {
  loadEnvFile('.env');
}

/**
 * PostgreSQL BIGSERIAL columns come back as BigInt, which `JSON.stringify`
 * throws on. The SRS asks for BIGSERIAL on stock_logs / order_items /
 * point_transactions, so rather than downcast those columns to INTEGER and
 * quietly cap them at 2.1 billion rows, we teach BigInt to serialise as a
 * decimal string — the same thing the TC39 BigInt-to-JSON proposal does.
 */
const bigIntPrototype = BigInt.prototype as unknown as { toJSON?: () => string };
if (typeof bigIntPrototype.toJSON !== 'function') {
  Object.defineProperty(bigIntPrototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** Reads a required environment variable, failing loudly when it is absent. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** Reads an optional environment variable with a numeric fallback. */
export function optionalNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
