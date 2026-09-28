/**
 * The plumbing the scripts that drive a real deployment share.
 *
 * Two scripts need the same three things: a PostgreSQL schema nobody else is
 * using, a production build served on a port the OS says is free, and an HTTP
 * session that can assert on a refusal without throwing. `acceptance.ts` grew
 * them first; `route-audit.ts` needs exactly the same ones. Keeping one copy
 * means a fix to "how do we start the server" — the Windows `taskkill`, the
 * one-shot `npx` shim, the Prisma-only `?schema=` parameter — lands in both.
 *
 * Nothing here knows anything about the application. It is deliberate: a helper
 * that understood orders or receipts would be a second implementation of the
 * thing being tested.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { loadEnvFile } from 'node:process';

import { Client } from 'pg';

/**
 * Loads `.env` into this process.
 *
 * Prisma 7 no longer does it, and a Node script is outside Next's bundler, so
 * every script that talks to the database has to do it itself. Real environment
 * variables always win, which is what lets CI pass `DATABASE_URL` directly.
 */
export function loadEnv(): void {
  if (existsSync('.env')) {
    loadEnvFile('.env');
  }
}

/** The connection string the scratch schema lives in, or null when unset. */
export function scratchSource(): string | null {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

/** Picks a port the OS says is free, so a running dev server is never disturbed. */
export async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 40; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`No free port between ${start} and ${start + 40}`);
}

/** The scratch connection string: the configured database, a private schema. */
export function scratchUrl(source: string, schema: string): string {
  const parsed = new URL(source);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

/**
 * Drops the scratch schema, optionally recreating it empty.
 *
 * The schema is recreated here rather than left to `prisma migrate deploy`, so
 * the run does not depend on whether the migration engine creates a missing
 * schema for a `?schema=` parameter.
 *
 * Connects with explicit fields rather than passing the URL straight to `pg`,
 * because `?schema=` is a Prisma-only parameter: libpq would reject it as an
 * unknown runtime setting.
 */
export async function resetScratchSchema(
  source: string,
  schema: string,
  recreate: boolean,
): Promise<void> {
  const parsed = new URL(source);
  const client = new Client({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (recreate) {
      await client.query(`CREATE SCHEMA "${schema}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * A `pg` client pointed at a scratch schema, for the few facts a script cannot
 * reach over HTTP — reading a row back, or seeding a fixture the API has no
 * route for.
 */
export async function scratchClient(url: string): Promise<Client> {
  const parsed = new URL(url);
  const client = new Client({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  });
  await client.connect();
  return client;
}

/** Runs a command through the shell, because npx on Windows is a `.cmd` shim. */
export function shell(step: string, command: string, env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, env: env ?? process.env });
  if (result.error) {
    throw new Error(`${step} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${step} failed with exit code ${result.status ?? 'null'}`);
  }
}

/** Starts the production server on a scratch schema, capturing its output. */
export function startServer(
  url: string,
  port: number,
): { child: ChildProcess; log: () => string } {
  const lines: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  return { child, log: () => lines.join('') };
}

/**
 * Waits for the server to answer, or explains what it said instead.
 *
 * `/api/v1/setup` is the probe because it is the one endpoint that is public,
 * answers without a session, and touches the database — so "it answered" means
 * the schema is migrated too, not merely that a socket is open.
 */
export async function waitForServer(base: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The server exited with code ${child.exitCode}.\n${log()}`);
    }
    try {
      const response = await fetch(`${base}/api/v1/setup`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`The server never answered on ${base}.\n${log()}`);
}

/** Stops the server, and makes sure it is really gone on Windows. */
export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    child.kill('SIGKILL');
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

export interface ApiResult<T> {
  status: number;
  data: T | null;
  error: string | null;
}

/**
 * A cookie jar per persona that never throws on an error status.
 *
 * The smoke test's version throws, which is right when every call is expected to
 * succeed. These scripts have to assert on refusals — 401, 403, 409, 422 — so
 * the status is returned rather than raised.
 *
 * The base URL is a function rather than a string because both drivers choose
 * their port after the class is written, and a captured string would be empty.
 */
export class Session {
  private cookie = '';

  constructor(private readonly base: () => string) {}

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      if (pair?.startsWith('pos_session=')) {
        this.cookie = pair;
      }
    }
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResult<T>> {
    const response = await fetch(`${this.base()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        /*
         * Extra headers, which is how a gated action presents its supervisor
         * approval. Without this the acceptance run could not exercise a refund
         * at all — and a journey that skips the gate would be testing a route no
         * till can actually reach.
         */
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
    this.absorb(response);

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const envelope = parsed as { data?: T; error?: { message?: string } } | null;
    return {
      status: response.status,
      data: (envelope?.data ?? null) as T | null,
      error: envelope?.error?.message ?? (envelope === null ? text.slice(0, 200) : null),
    };
  }

  /** Sends multipart form data, which is how the catalogue import works. */
  async postForm<T>(path: string, form: FormData): Promise<ApiResult<T>> {
    const response = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: this.cookie ? { cookie: this.cookie } : {},
      body: form,
      redirect: 'manual',
    });
    this.absorb(response);

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const envelope = parsed as { data?: T; error?: { message?: string } } | null;
    return {
      status: response.status,
      data: (envelope?.data ?? null) as T | null,
      error: envelope?.error?.message ?? (envelope === null ? text.slice(0, 200) : null),
    };
  }

  /** Sends a body that is expected to succeed, and explains itself when it does not. */
  async call<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const result = await this.request<T>(path, init);
    if (result.status >= 400 || result.error !== null) {
      throw new Error(`${init.method ?? 'GET'} ${path} → ${result.status}: ${result.error}`);
    }
    return result.data as T;
  }

  async login(credentials: { identifier: string; password: string }): Promise<void> {
    await this.call('/api/v1/auth/login', { method: 'POST', body: credentials });
  }

  raw(path: string): Promise<Response> {
    return fetch(`${this.base()}${path}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
      redirect: 'manual',
    });
  }

  /**
   * The session cookie as a `Cookie` header value, or an empty string when this
   * jar has not signed in.
   *
   * Exposed because a script that wants to walk pages itself has to send the
   * cookie by hand: `fetch` with `redirect: 'manual'` cannot be told to follow a
   * redirect *and* keep the jar, and a walk that silently dropped the session on
   * the first hop would audit the login page instead of the screen it asked for.
   */
  cookieHeader(): string {
    return this.cookie;
  }
}

/** A one-column CSV as the multipart form the catalogue import expects. */
export function csvForm(text: string, mode: 'preview' | 'commit', filename = 'catalogue.csv'): FormData {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), filename);
  form.append('mode', mode);
  return form;
}
