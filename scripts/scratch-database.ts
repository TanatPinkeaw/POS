/**
 * Where the restore lands, and how it is cleared away.
 *
 * §7's recipe restores into a fresh **database** the superuser creates. The drill
 * cannot assume that superuser: on CI `pos_app` *is* the cluster superuser, but on a
 * real install it is deliberately created `WITH LOGIN` and nothing more, and
 * `CREATEDB` is a role attribute — `GRANT CREATEDB` is not a thing, and `ALTER ROLE`
 * needs `CREATEROLE` the app role does not have. So the drill takes whichever of two
 * paths the role in `DATABASE_URL` can actually take, and says which in its output:
 *
 * - **A fresh database**, when the role can make one (CI; or a shop that granted
 *   `CREATEDB`). This is §7's shape exactly: the restore goes into a database that
 *   did not exist when the dump was taken.
 * - **The fixture schema, replaced**: the schema is dropped after its rows are
 *   counted, and the restore recreates it from the dump — which is §7's
 *   "put it back over the shop's own database" shape (`dropdb pos_dev; createdb;
 *   restore`), compressed into a schema because the schema is the namespace the
 *   dump actually carries. Here the dump genuinely is the only copy of the fixture
 *   for the length of the restore, which is the strongest statement a drill makes.
 *
 * Both paths run the same `psql --file` with the same SQL, so what is being
 * rehearsed — the dump-restore-count round trip with the shop's own client binaries
 * — is identical; only the namespace differs, and the output names it.
 */
import { Client } from 'pg';

import type { ConnectionParts } from '../src/lib/database-url';

export interface RestoreTarget {
  /** Which shape the restore took — printed, so a run is readable afterwards. */
  kind: 'database' | 'schema';
  /** The database a count-reading client connects to for both paths' checks. */
  connectDb: string;
  /** The database the psql restore is pointed at. */
  restoreDb: string;
}

async function withClient(
  parts: ConnectionParts,
  database: string,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({
    host: parts.host,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database,
  });
  await client.connect();
  try {
    await body(client);
  } finally {
    await client.end();
  }
}

/**
 * Makes the restore target.
 *
 * `fixtureCounts` is read by the caller *before* this runs; on the replace path the
 * schema is about to be dropped with those counts as the only record, which is the
 * point — a restore that fails here leaves nothing standing, exactly like a real
 * recovery.
 */
export async function createRestoreTarget(
  parts: ConnectionParts,
  fixtureSchema: string,
  database: string,
): Promise<{ target: RestoreTarget; note: string }> {
  try {
    await withClient(parts, parts.database, async (client) => {
      await client.query(`create database "${database}"`);
    });
    return {
      target: { kind: 'database', connectDb: database, restoreDb: database },
      note: `created fresh database ${database} (the §7 shape; the role may create databases here)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|insufficient privilege/i.test(message)) {
      throw error;
    }
    /* The replace path: same database, the fixture schema dropped so the restore
     * alone puts it back. `cascade`, because the schema owns every object in it. */
    await withClient(parts, parts.database, async (client) => {
      await client.query(`drop schema if exists "${fixtureSchema}" cascade`);
    });
    return {
      target: { kind: 'schema', connectDb: parts.database, restoreDb: parts.database },
      note: `role may not create databases — dropped ${fixtureSchema} and will let the restore put it back (the "over the shop's own database" shape, §7)`,
    };
  }
}

/** Clears the restore target — the scratch schema goes with it either way. */
export async function dropRestoreTarget(
  parts: ConnectionParts,
  target: RestoreTarget,
  database: string,
  fixtureSchema: string,
): Promise<void> {
  if (target.kind === 'database') {
    await withClient(parts, parts.database, async (client) => {
      await client.query(`drop database if exists "${database}" with (force)`);
    });
  } else {
    /* The restore recreated the fixture schema from the dump; dropping it again is
     * what leaves nothing behind. */
    await withClient(parts, parts.database, async (client) => {
      await client.query(`drop schema if exists "${fixtureSchema}" cascade`);
    });
  }
}
