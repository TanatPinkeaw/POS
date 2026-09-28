/**
 * Prisma client singleton.
 *
 * Prisma 7 talks to PostgreSQL through a driver adapter, and Next's dev-mode
 * module reloading would otherwise open a new pool on every hot reload — hence
 * the global cache.
 *
 * The `?schema=` parameter is read out of `DATABASE_URL` here, and that is not
 * decoration. It is Prisma's own parameter, and the driver-adapter path drops it:
 * `pg` accepts it and ignores it, so a URL saying `?schema=accept` was silently
 * reading and writing `public` instead. That is how the acceptance run — which
 * isolates itself in a scratch schema precisely so it can start from an empty
 * deployment — ended up reporting a configured shop it could not have seen.
 *
 * It has to be applied twice, because this codebase uses both kinds of query:
 *
 *   * `schema` on the adapter, which makes Prisma *qualify* the SQL it generates
 *     (`"accept"."shops"`), so a model query cannot be resolved by a stray
 *     `search_path`;
 *   * `search_path` on the connection, for the `$queryRaw` statements that carry
 *     the things Prisma cannot express — the generated `work_hours` column, and
 *     the conditional updates that make a payment intent spendable once.
 *
 * The session timezone is pinned to UTC for a third, considerably less obvious
 * reason — see the note on `SESSION_TIMEZONE`.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { requireEnv } from './env';

const globalForPrisma = globalThis as unknown as { __posPrisma?: PrismaClient };

/**
 * The timezone every connection runs in.
 *
 * Measured, not assumed: with the server's own default (Asia/Bangkok) the pg
 * driver adapter returned a timestamp *seven hours in the future* when the value
 * had been written by SQL — a `now()` default, which is most `created_at`
 * columns — and stored a JS `Date` seven hours in the past when it wrote one.
 * The two errors cancel on a round trip, which is why the codebase looked fine
 * while `expires_at > now()` checks silently failed and a five-minute PromptPay
 * QR advertised "424:54" remaining.
 *
 * `timestamptz` holds an instant, so the session timezone should never be
 * consulted for one — and every Bangkok-local rendering in this application is
 * done in TypeScript (`bangkok-time.ts`). Pinning it to UTC removes the
 * dependency instead of relying on a server setting being what we assumed. SQL
 * that genuinely wants a Bangkok calendar day now says so itself, with an
 * explicit `AT TIME ZONE 'Asia/Bangkok'` — as `attendance.ts` always has.
 */
const SESSION_TIMEZONE = 'UTC';

function createPrismaClient(): PrismaClient {
  const connectionString = requireEnv('DATABASE_URL');
  const schema = readSchemaParameter(connectionString);

  const sessionOptions = [
    ...(schema === null ? [] : [`search_path=${schema}`]),
    `timezone=${SESSION_TIMEZONE}`,
  ];

  const adapter = new PrismaPg(
    { connectionString, max: 10, options: sessionOptions.map((setting) => `-c ${setting}`).join(' ') },
    schema === null ? undefined : { schema },
  );

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * The `schema` parameter of a connection string, or null.
 *
 * Validated as a bare identifier before it is allowed anywhere near a
 * `search_path`, which is a setting rather than a bind parameter: interpolating
 * an unvalidated value there would turn a connection string into SQL. Anything
 * that is not a plain identifier is refused outright rather than escaped, because
 * a schema name needing escaping is not one this application was told to use.
 */
function readSchemaParameter(connectionString: string): string | null {
  let schema: string | null;
  try {
    schema = new URL(connectionString).searchParams.get('schema');
  } catch {
    return null;
  }

  return schema !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(schema) ? schema : null;
}

export const prisma: PrismaClient = globalForPrisma.__posPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__posPrisma = prisma;
}
