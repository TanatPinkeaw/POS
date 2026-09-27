/**
 * Prisma client singleton.
 *
 * Prisma 7 talks to PostgreSQL through a driver adapter, and Next's dev-mode
 * module reloading would otherwise open a new pool on every hot reload — hence
 * the global cache.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { requireEnv } from './env';

const globalForPrisma = globalThis as unknown as { __posPrisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: requireEnv('DATABASE_URL'),
    max: 10,
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.__posPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__posPrisma = prisma;
}
