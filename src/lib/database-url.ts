/**
 * Splitting `DATABASE_URL` into the parts a PostgreSQL binary can be handed.
 *
 * Prisma's URL carries a query — `?schema=public` — and libpq has no `schema`
 * parameter, so `pg_dump` refuses the string as written
 * (`invalid URI query parameter: "schema"`). Anything that shells out to
 * `pg_dump`/`psql` therefore needs the parts rather than the URL.
 *
 * The password comes back as a separate value on purpose: it is passed to the
 * child as `PGPASSWORD`, never in `argv`, which on Linux is world-readable
 * through `/proc/<pid>/cmdline` for as long as the dump runs.
 *
 * This module is pure — no `process.env`, no I/O — so the shapes a person can
 * type into `.env` are covered by `tests/database-url.test.ts` rather than
 * discovered during a backup.
 */

export interface ConnectionParts {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** The port libpq uses when the URL names none. */
export const DEFAULT_POSTGRES_PORT = 5432;

/**
 * Percent-decodes one URL component, leaving a malformed sequence as written:
 * a password that is not valid percent-encoding is far more likely to be a
 * literal `%` than a mistake worth refusing the backup over.
 */
function decode(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

/**
 * The connection described by `url`.
 *
 * Throws an English `Error` naming the missing part — this is configuration, not
 * something a user of the shop reads, and the person who has to fix it is
 * whoever wrote the `.env`.
 */
export function parseDatabaseUrl(url: string): ConnectionParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL is not a URL: ${url}. Expected postgresql://user:password@host:port/database`,
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `DATABASE_URL must start with postgresql:// — got ${parsed.protocol}//. ` +
        'This is the app\'s database, not a web address.',
    );
  }

  const database = decode(parsed.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new Error(`DATABASE_URL names no database: ${url}`);
  }

  const user = decode(parsed.username);
  if (user === '') {
    throw new Error(
      `DATABASE_URL names no user: ${url}. The installer writes one; a URL without it ` +
        'cannot be handed to pg_dump.',
    );
  }

  const password = decode(parsed.password);
  const host = parsed.hostname === '' ? 'localhost' : parsed.hostname;
  const port = parsed.port === '' ? DEFAULT_POSTGRES_PORT : Number(parsed.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`DATABASE_URL has an impossible port: ${parsed.port}`);
  }

  return { host, port, user, password, database };
}
