/**
 * One-command install (ADR 0002) — `npm run setup`.
 *
 * What a renter should have to do is run one command and then open a browser.
 * This script does the developer-shaped parts for them: it creates the database
 * role and both databases, writes a `.env` with a generated secret, and applies
 * every migration. The remaining decisions — the shop's name, whether it is
 * VAT-registered, who the administrator is — are made in the setup wizard, not
 * on the command line, because those are business questions rather than
 * deployment ones.
 *
 * Idempotent on purpose: running it twice is a no-op apart from re-applying
 * migrations, so "try again" is always a safe instruction.
 *
 * The Postgres superuser password is asked for, used, and never written
 * anywhere. Only the *application* role's password is stored, in `.env`.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const APP_ROLE = 'pos_app';
const APP_DB = 'pos_dev';
const TEST_DB = 'pos_test';
const PG_HOST = 'localhost';
const PG_PORT = '5432';

/** Where psql usually lives when it is not on PATH. */
const PSQL_FALLBACKS = [
  'psql',
  'C:/Program Files/PostgreSQL/17/bin/psql.exe',
  'C:/Program Files/PostgreSQL/16/bin/psql.exe',
  '/usr/bin/psql',
  '/usr/local/bin/psql',
  '/opt/homebrew/bin/psql',
];

function log(message: string): void {
  console.log(message);
}

/** Finds a usable psql, or explains how to get one. */
function findPsql(): string | null {
  for (const candidate of PSQL_FALLBACKS) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', shell: false });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Reads a value out of `.env` without a dotenv dependency.
 *
 * Only two values are ever read (the app role's password and the secret), so a
 * full parser would be more surface than the problem needs.
 */
function readEnvValue(name: string): string | null {
  if (!existsSync('.env')) {
    return null;
  }
  const match = new RegExp(`^${name}\\s*=\\s*"?([^"\\n]*)"?`, 'm').exec(readFileSync('.env', 'utf8'));
  return match?.[1] ?? null;
}

/** The password already embedded in DATABASE_URL, if there is one. */
function existingAppPassword(): string | null {
  const url = readEnvValue('DATABASE_URL');
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.password === '' ? null : decodeURIComponent(parsed.password);
  } catch {
    return null;
  }
}

/**
 * Ensures `.env` exists and holds a secret and an application password.
 *
 * An existing password is reused rather than rotated: rotating it here would
 * silently break a deployment that is already running against this database.
 */
function ensureEnvFile(): string {
  const appPassword = existingAppPassword() ?? randomBytes(12).toString('hex');
  const existingSecret = readEnvValue('AUTH_SECRET');
  const authSecret =
    existingSecret && existingSecret.length >= 32
      ? existingSecret
      : randomBytes(32).toString('hex');

  if (existsSync('.env')) {
    let contents = readFileSync('.env', 'utf8');
    let changed = false;

    // Only repair the secret when it is absent or still the placeholder.
    if (!existingSecret || existingSecret.startsWith('change-me')) {
      contents = /^AUTH_SECRET=/m.test(contents)
        ? contents.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${authSecret}"`)
        : `${contents.trimEnd()}\nAUTH_SECRET="${authSecret}"\n`;
      changed = true;
    }

    if (changed) {
      writeFileSync('.env', contents);
      log('  • updated .env (generated AUTH_SECRET)');
    } else {
      log('  • .env already present');
    }

    return appPassword;
  }

  const contents = [
    '# Written by `npm run setup`.',
    `DATABASE_URL="postgresql://${APP_ROLE}:${appPassword}@${PG_HOST}:${PG_PORT}/${APP_DB}?schema=public"`,
    `TEST_DATABASE_URL="postgresql://${APP_ROLE}:${appPassword}@${PG_HOST}:${PG_PORT}/${TEST_DB}?schema=public"`,
    `AUTH_SECRET="${authSecret}"`,
    '',
    'PORT=3000',
    'HOSTNAME=localhost',
    '',
    'PREORDER_CONFIRM_TIMEOUT_MINUTES=15',
    'PREORDER_HOLD_HOURS=4',
    '',
  ].join('\n');

  writeFileSync('.env', contents);
  log('  • created .env with a generated password and secret');
  return appPassword;
}

/** Runs one statement as the superuser, failing loudly. */
function psql(psqlPath: string, superuser: string, password: string, sql: string): { ok: boolean; out: string } {
  const result = spawnSync(
    psqlPath,
    ['-h', PG_HOST, '-p', PG_PORT, '-U', superuser, '-d', 'postgres', '-tAc', sql],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: password },
    },
  );

  if (result.error) {
    return { ok: false, out: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, out: (result.stderr ?? '').trim() };
  }
  return { ok: true, out: (result.stdout ?? '').trim() };
}

/**
 * Reads a password without echoing it.
 *
 * Falls back to a visible prompt when stdin is not a TTY (pipes, some Windows
 * shells) rather than hanging, and says so, so nobody is surprised by a password
 * appearing in their terminal scrollback.
 */
async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    log('  (stdin is not a terminal — the password will be visible as you type)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  }

  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      const char = chunk.toString('utf8');
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u0003') {
        // Ctrl-C
        stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  log('');
  log('POS Realtime — install');
  log('=====================');
  log('');

  if (!existsSync('package.json')) {
    console.error('Run this from the project root (no package.json here).');
    process.exit(1);
  }

  log('1. Configuration');
  const appPassword = ensureEnvFile();

  log('');
  log('2. PostgreSQL');
  const psqlPath = findPsql();
  if (!psqlPath) {
    console.error(
      [
        '',
        '  Could not find psql. Install PostgreSQL 17 first, then run this again:',
        '',
        '    winget install --id PostgreSQL.PostgreSQL.17 --exact   (Windows)',
        '    brew install postgresql@17                             (macOS)',
        '    apt install postgresql-17                              (Debian/Ubuntu)',
        '',
        '  If it is installed somewhere unusual, put it on PATH and re-run.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  log(`  • using ${psqlPath}`);

  const superuser = process.env.PGSUPERUSER ?? 'postgres';
  const superPassword =
    process.env.PGPASSWORD ?? (await promptPassword(`  password for PostgreSQL user "${superuser}": `));

  const roleCheck = psql(psqlPath, superuser, superPassword, `SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}'`);
  if (!roleCheck.ok) {
    console.error(`\n  Could not connect to PostgreSQL as "${superuser}":\n  ${roleCheck.out}\n`);
    process.exit(1);
  }

  const roleSql =
    roleCheck.out === '1'
      ? `ALTER ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${appPassword}'`
      : `CREATE ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${appPassword}'`;
  const roleResult = psql(psqlPath, superuser, superPassword, roleSql);
  if (!roleResult.ok) {
    console.error(`\n  Could not configure the "${APP_ROLE}" role:\n  ${roleResult.out}\n`);
    process.exit(1);
  }
  log(`  • role "${APP_ROLE}" ready`);

  /*
   * CREATE DATABASE cannot run inside a conditional block or a transaction, so
   * each database is probed first and created by a separate statement. That is
   * what makes this idempotent.
   */
  for (const database of [APP_DB, TEST_DB]) {
    const exists = psql(psqlPath, superuser, superPassword, `SELECT 1 FROM pg_database WHERE datname = '${database}'`);
    if (!exists.ok) {
      console.error(`\n  Could not list databases:\n  ${exists.out}\n`);
      process.exit(1);
    }
    if (exists.out === '1') {
      log(`  • database "${database}" already exists`);
      continue;
    }
    const created = psql(
      psqlPath,
      superuser,
      superPassword,
      `CREATE DATABASE "${database}" OWNER "${APP_ROLE}"`,
    );
    if (!created.ok) {
      console.error(`\n  Could not create "${database}":\n  ${created.out}\n`);
      process.exit(1);
    }
    log(`  • created database "${database}"`);
  }

  log('');
  log('3. Schema');
  // A single command string with `shell: true`: spawnSync cannot execute the
  // npx.cmd shim on Windows, and the failure is silent unless result.error is
  // read. Same pattern as scripts/prepare-test-db.ts.
  const migrate = spawnSync('npx prisma migrate deploy', { stdio: 'inherit', shell: true });
  if (migrate.error) {
    console.error('Could not run prisma migrate deploy:', migrate.error.message);
    process.exit(1);
  }
  if (migrate.status !== 0) {
    process.exit(migrate.status ?? 1);
  }

  if (readEnvValue('TEST_DATABASE_URL')) {
    const testMigrate = spawnSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DATABASE_URL: readEnvValue('TEST_DATABASE_URL') ?? '' },
    });
    if (testMigrate.status !== 0) {
      console.error('Migrations for the test database failed; the app database is fine.');
      process.exit(testMigrate.status ?? 1);
    }
  }

  log('');
  log('Ready.');
  log('');
  log('  Start it:      npm run dev');
  log('  Then open:     http://localhost:3000');
  log('');
  log('  The first page is the setup wizard: shop name, VAT, and the first');
  log('  administrator account. No demo data is installed — that is what');
  log('  `npm run db:seed:demo` is for, on a throwaway database.');
  log('');
}

main().catch((error: unknown) => {
  console.error('Setup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
