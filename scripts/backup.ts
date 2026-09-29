/**
 * `npm run backup` — the shop's database, in one file.
 *
 * `deploy/systemd/pos-backup.timer` runs this and `docs/renter-onboarding.md` §7
 * tells an operator to run it, so the dump command lives in exactly one place and
 * the two cannot drift.
 *
 * Usage:
 *   npm run backup                                    dump, then prune what aged out
 *   npm run backup -- --list                          show what is already there
 *   npm run backup -- --dir /srv/pos-backups --keep 30
 *   npm run backup -- --force                         allow a *test* database
 *
 * Exit code is 0 when a dump was written or listed, and 1 on every failure —
 * `pg_dump` missing, a dump that came back empty, an unwritable directory — because
 * the timer's journal is the only place anyone would notice. A backup that fails
 * quietly is the failure this file exists to prevent.
 *
 * It shells out to `pg_dump` rather than reading the database through Prisma: a
 * dump Prisma wrote would be a format only this code could restore, and the point
 * of a backup is that ordinary `psql` can read it on a day this repo is gone.
 */
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

// Side-effect import: `src/lib/env.ts` loads `.env` for anything running outside
// Next's bundler, which this script is.
import '../src/lib/env';

import { bangkokParts, MS_PER_DAY } from '../src/lib/bangkok-time';
import { parseDatabaseUrl, type ConnectionParts } from '../src/lib/database-url';
import { requireEnv } from '../src/lib/env';

const BACKUP_NAME = /^pos-\d{8}-\d{6}\.sql\.gz$/;

const pad2 = (value: number): string => value.toString().padStart(2, '0');

/** `20260929-023000`, in Bangkok — the name sorts as it reads, which is the point. */
function fileStamp(now: Date): string {
  const { year, month, day, hour, minute } = bangkokParts(now);
  // Seconds need no Bangkok conversion: every fixed offset is a whole number of
  // minutes, and Thailand has had no daylight saving since 1941.
  return `${year}${pad2(month)}${pad2(day)}-${pad2(hour)}${pad2(minute)}${pad2(now.getUTCSeconds())}`;
}

/** `03/10/2026 02:30` in Bangkok, for a report a person reads. */
function readable(date: Date): string {
  const { year, month, day, hour, minute } = bangkokParts(date);
  return `${pad2(day)}/${pad2(month)}/${year} ${pad2(hour)}:${pad2(minute)}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Options {
  dir: string;
  keepDays: number;
  list: boolean;
  force: boolean;
}

function readOptions(argv: string[]): Options {
  const value = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const keepDays = Number(value('keep') ?? process.env.BACKUP_KEEP_DAYS ?? '14');

  if (!Number.isFinite(keepDays) || keepDays < 0) {
    throw new Error(
      `--keep must be a number of days, and 0 means keep everything (got ${keepDays})`,
    );
  }

  return {
    dir: resolve(value('dir') ?? process.env.BACKUP_DIR ?? join(process.cwd(), 'backups')),
    keepDays,
    list: argv.includes('--list'),
    force: argv.includes('--force'),
  };
}

/** Every file this script has written, newest first — the name sorts that way. */
function existingBackups(dir: string): { path: string; size: number; mtimeMs: number }[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      const stats = statSync(path);
      return { path, size: stats.size, mtimeMs: stats.mtimeMs };
    })
    .sort((left, right) => right.path.localeCompare(left.path));
}

/**
 * Dumps the database into `target`, through a temp file.
 *
 * Deliberately not `pg_dump | gzip`: a pipe reports the compressor's exit code, so a
 * `pg_dump` that died halfway still produces a valid archive of half a shop.
 */
async function dump(
  parts: ConnectionParts,
  target: string,
): Promise<{ bytes: number; tookMs: number }> {
  const temp = `${target}.part`;
  const started = Date.now();
  let completed = false;

  try {
    const result = spawnSync(
      'pg_dump',
      [
        '-h', parts.host,
        '-p', String(parts.port),
        '-U', parts.user,
        '-d', parts.database,
        // Without this a wrong password waits on stdin, and under systemd there is no
        // stdin to answer on: the timer would sit there until its own timeout.
        '--no-password',
        '--file', temp,
      ],
      {
        // The password goes in the environment, never in `argv`:
        // /proc/<pid>/cmdline is readable by every local user while the dump runs.
        env: parts.password === '' ? process.env : { ...process.env, PGPASSWORD: parts.password },
        // pg_dump's own diagnosis is more useful than anything translated here, so it
        // goes straight to the journal.
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? 'pg_dump is not installed. On Debian/Ubuntu: apt install postgresql-client'
          : `could not run pg_dump: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(`pg_dump exited with status ${result.status} (its own message is above)`);
    }

    if (!existsSync(temp) || statSync(temp).size === 0) {
      throw new Error(
        "pg_dump wrote nothing — check that DATABASE_URL points at the shop's database " +
          'and that the role can log in',
      );
    }

    await pipeline(createReadStream(temp), createGzip({ level: 6 }), createWriteStream(target));
    completed = true;

    return { bytes: statSync(target).size, tookMs: Date.now() - started };
  } finally {
    rmSync(temp, { force: true });
    // A gzip that stopped halfway leaves a file the next run would count as a backup,
    // so a failed attempt takes its output with it.
    if (!completed) {
      rmSync(target, { force: true });
    }
  }
}

/** Deletes backups older than the retention window, and says what went. */
function prune(options: Options, now: Date): { count: number; bytes: number } {
  // `--keep 0` is the documented way to say "never delete anything". A cutoff of
  // `now` would instead mean "delete everything that exists", which is the exact
  // opposite, so it is handled before the arithmetic rather than by it.
  if (options.keepDays === 0) {
    return { count: 0, bytes: 0 };
  }

  const cutoff = now.getTime() - options.keepDays * MS_PER_DAY;
  let count = 0;
  let bytes = 0;

  for (const backup of existingBackups(options.dir)) {
    if (backup.mtimeMs >= cutoff) {
      continue;
    }
    rmSync(backup.path, { force: true });
    count += 1;
    bytes += backup.size;
  }

  return { count, bytes };
}

function listBackups(dir: string): void {
  const backups = existingBackups(dir);

  console.log(`\n${dir}\n`);
  if (backups.length === 0) {
    console.log('  (nothing yet — run this without --list to write one)');
    return;
  }

  for (const backup of backups) {
    console.log(
      `  ${readable(new Date(backup.mtimeMs))}  ${megabytes(backup.size).padStart(9)}  ${backup.path}`,
    );
  }

  const total = backups.reduce((sum, backup) => sum + backup.size, 0);
  console.log(`\n${backups.length} backups, ${megabytes(total)}`);
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));

  console.log('');
  console.log('POS — database backup');
  console.log('=====================');

  if (options.list) {
    listBackups(options.dir);
    return;
  }

  const parts = parseDatabaseUrl(requireEnv('DATABASE_URL'));

  /*
   * Refusing a database whose name says "test" is the rule the test suite applies to
   * `TEST_DATABASE_URL`, for the mirror-image reason: a dump of the scratch database
   * looks exactly like a real backup and is only discovered by the person restoring
   * it, months later, when the shop's data is not in it.
   */
  if (!options.force && /test/i.test(parts.database)) {
    throw new Error(
      `DATABASE_URL points at "${parts.database}", which looks like a test database. ` +
        'Refusing to write something that is not the shop. Pass --force if you meant it.',
    );
  }

  mkdirSync(options.dir, { recursive: true });

  const target = join(options.dir, `pos-${fileStamp(new Date())}.sql.gz`);

  console.log(`\nSource:  ${parts.database} on ${parts.host}:${parts.port} (role ${parts.user})`);
  console.log(`Writing: ${target}`);

  const written = await dump(parts, target);
  console.log(`  ✓ ${megabytes(written.bytes)} in ${(written.tookMs / 1000).toFixed(1)}s`);

  const pruned = prune(options, new Date());
  if (pruned.count > 0) {
    console.log(
      `Dropped ${pruned.count} older than ${options.keepDays} days, freeing ${megabytes(pruned.bytes)}`,
    );
  }

  const kept = existingBackups(options.dir);
  const total = kept.reduce((sum, backup) => sum + backup.size, 0);
  console.log(`\n${kept.length} backups kept, ${megabytes(total)} — ${options.dir}`);
  console.log(`Oldest kept: ${readable(new Date(kept[kept.length - 1]!.mtimeMs))}`);

  /*
   * A backup on the same disk as the database is a copy, not a backup. Only said when
   * it is true, because a warning that always fires is one nobody reads.
   */
  if (options.dir.startsWith(process.cwd())) {
    console.log(
      '\nNote: that directory is inside the checkout, so it is a copy rather than a backup.\n' +
        'Point --dir at another disk, a NAS, or a share a sync job copies — and see\n' +
        'docs/homelab-deploy.md §7.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
