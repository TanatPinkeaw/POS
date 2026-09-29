/**
 * Two servers, one database, one limit.
 *
 * The unit suite proves the store's properties — that a spent attempt is in the
 * table, that a re-imported module still refuses, and that concurrent attempts on one
 * bucket let exactly the capacity through. What it cannot prove is the deployment the
 * change was made for: **two processes**, each with its own connection pool, its own
 * module instance and its own HTTP listener, enforcing one limit between them.
 *
 * That distinction is the whole of ADR 0012. Before it, the buckets were a `Map` in
 * the process, so two processes were two limiters — each permitting the full capacity,
 * so a shop that scaled to a second register would have found its ceilings twice as
 * generous as the configuration says, and nobody would have noticed. This script starts
 * exactly that deployment, signs the *same* cashier account in at both tills, and
 * spends a burst from both at once. If the buckets ever go back in the process, the
 * total is twice what it should be and this fails.
 *
 * Usage:
 *   npm run limiter:race                    drop → migrate → build → serve → race
 *   npm run limiter:race -- --skip-build    reuse the existing `.next` build
 *   npm run limiter:race -- --keep          leave the scratch schema to inspect
 */
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import { RATE_LIMIT_POLICIES } from '../src/lib/rate-limit-policy';

import {
  Session,
  freePort,
  loadEnv,
  resetScratchSchema,
  scratchUrl,
  shell,
  startServer,
  stopServer,
  waitForServer,
} from './harness';

/** A schema of its own, so this can run beside acceptance and the route audit. */
const SCRATCH_SCHEMA = 'limiterrace';
const FIRST_PORT = 3410;

const SHOP = {
  name: 'ร้านทดสอบลิมิต เหลี่ยมนอก',
  branchLabel: 'สาขาทดสอบ',
  taxId: '1103700999999',
  isVatRegistered: true,
  vatRate: 7,
  receiptPrefix: 'LR',
};

const ADMIN = { fullName: 'ผู้จัดการ เหลี่ยมนอก', phone: '0800000600', password: 'race-admin-1' };

/**
 * One cashier, signed in at both tills.
 *
 * The bucket is keyed by the *account* (ADR 0011 §6), so two tills sharing a limit is
 * precisely the case where the same person is working two registers — and it is also
 * the case that would silently get twice the allowance if the buckets were per process.
 */
const CASHIER = { fullName: 'มาลี เหลี่ยมนอก', phone: '0800000601', password: 'race-cashier-1' };

/** What one till spent the burst on. Filled by the two loops, read by the checks. */
interface Burst {
  successes: number;
  lastStatus: number | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes('--skip-build');
  const keep = argv.includes('--keep');

  loadEnv();

  const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
  if (sourceUrl === null) {
    throw new Error('Neither TEST_DATABASE_URL nor DATABASE_URL is set. Run `npm run setup` first.');
  }

  /*
   * The server boot does not need this, but the harness's own contract is that a run
   * never depends on a secret the renter configured — a scratch schema has no `.env`
   * of its own to check.
   */
  process.env.PAYMENT_WEBHOOK_SECRET ??= 'limiter-race-secret';

  let passed = 0;
  let failed = 0;

  const check = (label: string, condition: boolean, detail?: unknown): void => {
    if (condition) {
      passed += 1;
      console.log(`  ✓ ${label}`);
      return;
    }
    failed += 1;
    console.error(
      `  ✗ ${label}${detail === undefined ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
    );
  };

  console.log('');
  console.log('POS — one limit, two servers');
  console.log('============================');

  const scratch = scratchUrl(sourceUrl, SCRATCH_SCHEMA);
  console.log(`\nScratch schema: ${SCRATCH_SCHEMA} (in ${new URL(sourceUrl).pathname.replace(/^\//, '')})`);

  await resetScratchSchema(sourceUrl, SCRATCH_SCHEMA, true);
  shell('prisma migrate deploy', 'npx prisma migrate deploy', {
    ...process.env,
    DATABASE_URL: scratch,
  });

  if (skipBuild) {
    if (!existsSync('.next/BUILD_ID')) {
      throw new Error('There is no .next build to reuse. Run without --skip-build.');
    }
    console.log('\nBuild: skipped (--skip-build); reusing the existing .next output');
  } else {
    console.log('\nBuilding (this also type-checks every route)');
    shell('next build', 'npx next build');
  }

  const portA = await freePort(FIRST_PORT);
  const portB = await freePort(portA + 1);
  const baseA = `http://127.0.0.1:${portA}`;
  const baseB = `http://127.0.0.1:${portB}`;

  console.log(`\nServing the same schema on ${baseA} and ${baseB}`);
  const startedA = startServer(scratch, portA);
  const startedB = startServer(scratch, portB);
  const children: ChildProcess[] = [startedA.child, startedB.child];

  try {
    await Promise.all([
      waitForServer(baseA, startedA.child, startedA.log),
      waitForServer(baseB, startedB.child, startedB.log),
    ]);
    check(
      'two server processes are up, with a database connection each',
      startedA.child.pid !== undefined &&
        startedB.child.pid !== undefined &&
        startedA.child.pid !== startedB.child.pid,
      { a: startedA.child.pid, b: startedB.child.pid },
    );

    /*
     * The shop, its administrator and one cashier, all over HTTP — the same starting
     * condition `acceptance` builds, minus everything this script does not need.
     */
    const bootstrap = new Session(() => baseA);
    await bootstrap.call('/api/v1/setup', {
      method: 'POST',
      body: { shop: SHOP, admin: ADMIN },
    });
    await bootstrap.login({ identifier: ADMIN.phone, password: ADMIN.password });
    await bootstrap.call('/api/v1/staff', {
      method: 'POST',
      body: {
        fullName: CASHIER.fullName,
        phone: CASHIER.phone,
        role: 'employee',
        password: CASHIER.password,
      },
    });

    const tillA = new Session(() => baseA);
    const tillB = new Session(() => baseB);
    await tillA.login({ identifier: CASHIER.phone, password: CASHIER.password });
    await tillB.login({ identifier: CASHIER.phone, password: CASHIER.password });

    const accountA = await tillA.call<{ id: string }>('/api/v1/auth/me');
    const accountB = await tillB.call<{ id: string }>('/api/v1/auth/me');
    check(
      'the same cashier is signed in at both tills',
      accountA.id === accountB.id,
      `${accountA.id} / ${accountB.id}`,
    );

    /*
     * One till's loop: enrol until the door shuts. Each till keeps going until *it* is
     * refused, which is what makes the two loops interleave in the middle of the burst
     * rather than each spending a clean ten.
     */
    const enrolUntilRefused = async (session: Session, till: string): Promise<Burst> => {
      const burst: Burst = { successes: 0, lastStatus: null };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await session.request('/api/v1/members', {
          method: 'POST',
          body: {
            fullName: `ลูกค้าแข่ง ${till}-${attempt}`,
            phone: `0821${till}${String(attempt).padStart(4, '0')}`,
            password: 'race-burst-1',
          },
        });
        burst.lastStatus = result.status;
        if (result.status === 429) {
          return burst;
        }
        if (result.status >= 400) {
          throw new Error(`Enrolment at till ${till} → ${result.status}: ${result.error}`);
        }
        burst.successes += 1;
      }
      return burst;
    };

    console.log('\nRacing both tills at the same door');
    const [burstA, burstB] = await Promise.all([
      enrolUntilRefused(tillA, '1'),
      enrolUntilRefused(tillB, '2'),
    ]);
    const total = burstA.successes + burstB.successes;
    const capacity = RATE_LIMIT_POLICIES.member_create.capacity;
    console.log(`  • till A spent ${burstA.successes}, till B spent ${burstB.successes}`);

    check(
      'both tills are refused once the shop has spent its burst (429)',
      burstA.lastStatus === 429 && burstB.lastStatus === 429,
      { a: burstA.lastStatus, b: burstB.lastStatus },
    );
    /*
     * The assertion this script exists for. Two independent limiters would allow the
     * capacity at *each* till — `2 × capacity` — and that is the number the old
     * in-process buckets produced.
     */
    check(
      `and the two servers spent one burst of ${capacity} between them, not one each`,
      total === capacity,
      { total, capacity },
    );

    const trail = await bootstrap.call<{
      entries: { detail: Record<string, unknown> | null }[];
      total: number;
    }>('/api/v1/audit?action=rate_limited');
    const rows = trail.entries.filter((entry) => entry.detail?.policy === 'member_create');
    check(
      'and the shared refusal reaches the trail once, not once per server',
      rows.length === 1 && rows[0]?.detail?.scope === accountA.id,
      rows[0] ?? trail.total,
    );

    console.log(
      failed === 0
        ? `\nlimiter race: ${passed} passed, 0 failed`
        : `\nlimiter race: ${passed} passed, ${failed} FAILED`,
    );
  } finally {
    await Promise.all(children.map((child) => stopServer(child)));
    if (!keep) {
      await resetScratchSchema(sourceUrl, SCRATCH_SCHEMA, false);
      console.log('\nScratch schema dropped');
    } else {
      console.log(`\nScratch schema kept: ${scratch}`);
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(`\nLimiter race could not complete:\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
