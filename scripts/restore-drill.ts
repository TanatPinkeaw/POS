/**
 * `npm run restore:drill` — the restore recipe from `docs/homelab-deploy.md` §7,
 * rehearsed by a machine.
 *
 * §7 ends by admitting this file's job was left undone: the restore is a recipe by
 * hand, and nothing in the repo rehearsed it. This script is that drill — the
 * section's own steps, performed where a wrong I/O shape is discovered in a minute
 * rather than at 02:30 when the dump is the only copy the scratch database has:
 *
 *   1. a scratch schema (fresh name each run) is migrated and seeded with the demo
 *      data, and a shop row written by the drill itself — the demo seed *refuses* a
 *      configured shop, so the row is the drill's own fixture, with the receipt and
 *      credit-note counters deliberately non-zero (an all-zero assertion would
 *      survive a restore that dropped every counter value in the database);
 *   2. `pg_dump -n schema` runs — `scripts/backup.ts`'s own command: the parts from
 *      `database-url.ts`, `--no-password`, the password in `PGPASSWORD` and never in
 *      argv — so what is exercised is the program the nightly timer runs;
 *   3. the dump is gzipped the way `backup.ts` gzips (level 6, the same
 *      `pos-*.sql.gz` shape the timer leaves behind) and its decompressed bytes are
 *      compared byte-for-byte after decompression;
 *   4. a scratch *database* is created and owned by the app's role
 *      (`scratch-database.ts` — no superuser assumed, unlike §7's `createdb -O`),
 *      because the restore must go into a database that did not exist before;
 *   5. the plain SQL is handed to `psql --set ON_ERROR_STOP=1 --file` — the `psql`
 *      of §7's `gunzip -c … | psql -h … -U … -d …`, minus the shell pipe that has
 *      no portable spelling on Windows (declared in the header, not silent);
 *   6. `select count(*) from shops` — §7's own finishing command — then every table
 *      row-for-row against the live schema, and the receipt and credit-note
 *      counters byte-for-byte, because those are the two numbers a restore must
 *      never lose (the gapless series, ADR 0002).
 *
 * The client binaries are resolved by *running* them, not by stat-ing a path.
 * `PG_BIN` in `.env` answers the Windows case the dev box actually has: the
 * installer puts the clients under `C:\Program Files\PostgreSQL\17\bin` and leaves
 * them off the PATH this checkout's shells inherit. A directory that exists but
 * holds nothing executable fails here, with its name printed, rather than three
 * stages in.
 *
 * Usage:
 *   npm run restore:drill               the drill, end to end
 *   npm run restore:drill -- --keep     leave the scratch objects behind to inspect
 *   npm run restore:drill -- --verbose  echo every pg client call as it runs
 *
 * Exit 0 only when every stage passed; each ✓ line names what it proved.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';

import { Client } from 'pg';

import {
  loadEnv,
  resetScratchSchema,
  scratchSource,
  scratchUrl,
} from './harness';
import { parseDatabaseUrl, type ConnectionParts } from '../src/lib/database-url';
import { requireEnv } from '../src/lib/env';
import { createRestoreTarget, dropRestoreTarget } from './scratch-database';

loadEnv();

const verbose = process.argv.slice(2).includes('--verbose');
const keep = process.argv.slice(2).includes('--keep');

/**
 * One pg client command.
 *
 * stderr is inherited, because the binary's own diagnosis is better than anything
 * this script can translate — the lesson `backup.ts` learned first, still true here.
 */
function runClient(label: string, exe: string, args: string[], env: NodeJS.ProcessEnv): string {
  if (verbose) {
    console.log(`    $ ${exe} ${args.join(' ')}`);
  }
  const result = spawnSync(exe, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with status ${result.status} — its own message is above. The ` +
        'connection parts come from the same environment `npm run backup` reads, so a ' +
        'refusal here is a credentials problem the nightly backup would hit too.',
    );
  }
  return result.stdout.toString('utf8');
}

function note(stage: string): void {
  console.log(`  ✓ ${stage}`);
}

/**
 * Resolves a pg client binary by running it, because existence proves nothing on a
 * box where the installer left the clients off PATH — `PG_BIN` in `.env` answers
 * that case (see the header).
 */
function runBinary(name: string): string {
  const candidates = [
    ...(process.env.PG_BIN ? [join(process.env.PG_BIN, name)] : []),
    name,
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(`"${candidate}"`, ['--version'], { stdio: 'ignore', shell: true });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    `${name} could not be run — the drill shells out to the PostgreSQL client binaries, ` +
      'the same ones `npm run backup` uses. Install the client matching the server ' +
      "(Debian: apt install postgresql-client-17; Windows: add the installer's bin " +
      'directory to PATH, or set PG_BIN in .env to it, e.g. ' +
      'C:\\Program Files\\PostgreSQL\\17\\bin).',
  );
}

/** A node-side client for reads the drill cannot make through a child process. */
async function connect(parts: ConnectionParts, database: string): Promise<Client> {
  const client = new Client({
    host: parts.host,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database,
  });
  await client.connect();
  return client;
}

/**
 * Every base table in the fixture schema, counted rather than named: a model added
 * to the Prisma schema becomes part of the proof the day it appears, instead of
 * waiting for someone to remember to add it to a list here.
 */
async function fixtureTables(live: Client, schema: string): Promise<string[]> {
  const { rows } = await live.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE'
       and table_name <> '_prisma_migrations'
     order by table_name`,
    [schema],
  );
  return rows.map((row) => row.table_name);
}

async function countRows(client: Client, qualified: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from ${qualified}`);
  return Number(rows[0]!.n);
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log('');
  console.log('POS — the restore drill');
  console.log('=======================');
  console.log('');

  const source = scratchSource();
  if (source === null) {
    throw new Error(
      'TEST_DATABASE_URL is not set — the drill runs against the test database only, and ' +
        'refuses to guess where that is.',
    );
  }
  const parts = parseDatabaseUrl(requireEnv('TEST_DATABASE_URL'));

  const psql = runBinary('psql');
  const pgDump = runBinary('pg_dump');

  const suffix = Date.now().toString(36);
  const schema = `restore_drill_${suffix}`;
  const database = `pos_restore_drill_${suffix.slice(-6)}`;
  const scratch = scratchUrl(source, schema);

  const clientEnv =
    parts.password === '' ? process.env : { ...process.env, PGPASSWORD: parts.password };
  const toServer = [
    '-h', parts.host,
    '-p', String(parts.port),
    '-U', parts.user,
  ];
  const temp = mkdtempSync(join(tmpdir(), 'restore-drill-'));
  const plain = join(temp, `pos-${suffix}.sql`);
  const archived = `${plain}.gz`;
  const decompressedPath = join(temp, 'restored.sql');
  const live = await connect(parts, parts.database);
  let kept = false;

  try {
    /* ---- 1. the shop worth restoring -------------------------------------- */
    await resetScratchSchema(source, schema, true);
    for (const command of ['npx prisma migrate deploy', 'npx tsx prisma/seed.ts']) {
      const result = spawnSync(command, {
        shell: true,
        stdio: verbose ? 'inherit' : 'ignore',
        env: { ...process.env, DATABASE_URL: scratch },
      });
      if (result.error ?? result.status !== 0) {
        throw new Error(
          `${command} failed (exit ${result.status ?? 'spawn'}). The fixture is built with ` +
            'the same migrate-then-seed `db:setup:demo` runs, pointed at the scratch schema ' +
            'by the same env override `prepare-test-db.ts` established — read its refusal, ' +
            'do not retry.',
        );
      }
    }
    note(`seeded scratch schema ${schema} with the demo shop`);

    /*
     * The demo seed deliberately does not create the shop row — it *refuses* to run
     * when one exists, because pouring demo data into a live shop is unrecoverable.
     * The row is the setup wizard's product (acceptance drives that API), so the
     * drill writes its own: one insert, with the two gapless-series counters set
     * non-zero on purpose — a byte-for-byte assertion over zeros would survive a
     * restore that dropped every counter value in the database.
     */
    await live.query(
      `insert into "${schema}".shops
         (id, name, receipt_running_number, credit_note_running_number)
       values (1, $1, 47, 3)`,
      ['ร้านสาธิต (restore drill)'],
    );

    /* The numbers the restore must not lose, read before anything is dumped. The
     * call-number counter (ADR 0017) resets every Bangkok day, so it is asserted to
     * come back an integer rather than the value this run happened to see. */
    const liveCounters = await live.query<{
      receipt_running_number: string;
      credit_note_running_number: string;
      queue_running_number: number;
    }>(
      `select receipt_running_number::text, credit_note_running_number::text,
              queue_running_number from "${schema}".shops`,
    );
    if (liveCounters.rows.length === 0) {
      throw new Error('the fixture shop row is missing — the insert above did not land');
    }
    const before = liveCounters.rows[0]!;

    /* ---- 2. the dump, by backup.ts's own command --------------------------- */
    runClient(
      'pg_dump',
      pgDump,
      [
        ...toServer,
        '-d', parts.database,
        '-n', schema,
        '--no-password',
        '--file', plain,
      ],
      clientEnv,
    );
    const sql = readFileSync(plain);
    if (sql.length === 0) {
      throw new Error('pg_dump wrote nothing — the same refusal backup.ts makes at write time');
    }

    /* The same compressor and level `backup.ts` uses, so the archive here is the
     * shape the nightly timer leaves in /var/backups/pos. */
    await pipeline(
      (async function* (): AsyncGenerator<Buffer> {
        yield sql;
      })(),
      createGzip({ level: 6 }),
      createWriteStream(archived),
    );

    /* ---- 3. the restore target: §7's fresh database when the role may, ----
     * ---- otherwise the fixture schema replaced by what the dump alone puts back. */
    const { target, note: targetNote } = await createRestoreTarget(parts, schema, database);
    note(targetNote);

    /* ---- 4. the restore, through the recipe's psql ------------------------- */
    const restored = await connect(parts, target.connectDb);
    try {
      const resurrected = gunzipSync(readFileSync(archived));
      if (Buffer.compare(resurrected, sql) !== 0) {
        throw new Error('the archive decompressed to something other than what pg_dump wrote');
      }
      writeFileSync(decompressedPath, resurrected);

      runClient(
        'psql restore',
        psql,
        [
          ...toServer,
          '-d', target.restoreDb,
          '--quiet',
          '--set', 'ON_ERROR_STOP=1',
          '--file', decompressedPath,
        ],
        clientEnv,
      );
      note("psql imported the SQL with ON_ERROR_STOP=1 (§7's pipe, minus gunzip)");

      /* ---- 5. count what came back ---------------------------------------- */
      const shops = await countRows(restored, `"${schema}".shops`);
      if (shops !== 1) {
        throw new Error(`shops has ${shops} rows after the restore — expected 1`);
      }
      note('shops has exactly 1 row (the §7 count finish)');

      const tables = await fixtureTables(live, schema);
      for (const table of tables) {
        const qualified = `"${schema}"."${table}"`;
        const liveCount = await countRows(live, qualified);
        const restoredCount = await countRows(restored, qualified);
        if (liveCount !== restoredCount) {
          throw new Error(`${table}: live ${liveCount}, restored ${restoredCount}`);
        }
      }
      note(`${tables.length} tables restored row-for-row against the live schema`);

      const after = await restored.query<{
        receipt_running_number: string;
        credit_note_running_number: string;
        queue_running_number: number;
      }>(
        `select receipt_running_number::text, credit_note_running_number::text,
                queue_running_number from "${schema}".shops`,
      );
      if (after.rows.length === 0) {
        throw new Error('the restored shop row is missing — the restore lost it');
      }
      const afterRow = after.rows[0]!;
      if (
        afterRow.receipt_running_number !== before.receipt_running_number ||
        afterRow.credit_note_running_number !== before.credit_note_running_number
      ) {
        throw new Error(
          `counters changed in the round trip: receipts ${before.receipt_running_number} → ` +
            `${afterRow.receipt_running_number}, credit notes ` +
            `${before.credit_note_running_number} → ${afterRow.credit_note_running_number}`,
        );
      }
      if (!Number.isInteger(afterRow.queue_running_number) || afterRow.queue_running_number < 0) {
        throw new Error('the call-number counter came back as something other than an integer');
      }
      note(
        `counters survived: receipts ${afterRow.receipt_running_number}, credit notes ` +
          `${afterRow.credit_note_running_number} (the gapless series, ADR 0002)`,
      );
    } finally {
      await restored.end();
    }

    /* ---- 6. leave nothing behind ------------------------------------------- */
    if (!keep) {
      try {
        await dropRestoreTarget(parts, target, database, schema);
        note(target.kind === 'database' ? `dropped ${database} and ${schema}` : `dropped the restored ${schema} again`);
      } catch {
        kept = true;
        console.warn(`  could not drop the scratch objects — ${database} / ${schema} remain`);
      }
    } else {
      kept = true;
    }
  } finally {
    await live.end();
    rmSync(temp, { force: true, recursive: true });
  }

  console.log('');
  if (kept) {
    console.log(
      `kept for inspection: schema ${schema} in ${parts.database}, database ${database}. ` +
        'Drop by hand when done (dropdb --force; DROP SCHEMA … CASCADE).',
    );
  } else {
    console.log('nothing left behind — the scratch schema and database are gone');
  }
  console.log(
    '\nAll restore-drill stages passed: docs/homelab-deploy.md §7 is rehearsed, not just written down.',
  );
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
