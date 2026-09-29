// Seam under test: what a caller spends when a door is counted, against a real
// database.
//
// The arithmetic is pinned in `rate-limit-policy.test.ts` without a database; what
// this file pins is the part that only exists at runtime — that a refusal is a 429
// rather than a 500, that two accounts do not share a bucket, and that a burst
// writes *one* row to the trail rather than one per refused request. The last of
// those is the one worth a real database: it is the difference between a limiter
// and an amplifier an attacker points at the audit table.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listAuditLogs } from '@/lib/audit';
import { RateLimitedError } from '@/lib/errors';
import { chargeRateLimit, rateLimitBucketCount, resetRateLimits } from '@/lib/rate-limit';
import { RATE_LIMIT_POLICIES } from '@/lib/rate-limit-policy';

import { prisma, resetDatabase } from './helpers/test-db';

/** A request as the custom server presents one: the socket address, stamped on. */
function requestFrom(address: string, forwardedFor?: string): Request {
  return new Request('http://localhost/api/v1/auth/login', {
    method: 'POST',
    headers: {
      'x-client-address': address,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
  });
}

/** Spends the whole capacity, then returns whether the next attempt was refused. */
async function spendAndRefuse(
  request: Request,
  policy: keyof typeof RATE_LIMIT_POLICIES,
  scope?: string,
): Promise<unknown> {
  const { capacity } = RATE_LIMIT_POLICIES[policy];
  for (let attempt = 0; attempt < capacity; attempt += 1) {
    await chargeRateLimit(request, policy, scope);
  }
  return chargeRateLimit(request, policy, scope).catch((error: unknown) => error);
}

beforeEach(async () => {
  await resetDatabase();
  // The buckets are rows in the shop's own database now (ADR 0012), so a suite that
  // did not clear them would inherit the previous test's spent bucket — and now also
  // the previous *run*'s, which is a flake nobody can reproduce locally.
  await resetRateLimits();
});

afterEach(async () => {
  await resetRateLimits();
});

describe('charging an attempt', () => {
  it('lets a caller spend the capacity and refuses the attempt after it', async () => {
    const request = requestFrom('203.0.113.9');

    const refused = await spendAndRefuse(request, 'login_failure', 'cashier@shop.test');

    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).httpStatus).toBe(429);
    expect((refused as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps one account out of another account`s bucket', async () => {
    const request = requestFrom('203.0.113.9');

    await spendAndRefuse(request, 'login_failure', 'first@shop.test');

    // The same address, a different identifier: untouched, because a limit that
    // locked out a colleague would be a limit the shop turns off.
    await expect(
      chargeRateLimit(request, 'login_failure', 'second@shop.test'),
    ).resolves.toBeUndefined();
  });

  it('gives each signed-in account its own enrolment budget', async () => {
    const request = requestFrom('127.0.0.1');

    await spendAndRefuse(request, 'member_create', 'cashier-1');

    // One shop, one address, two tills: the second cashier's budget is theirs, and
    // the first one's is spent. Keying this by address instead would let whoever
    // types fastest lock out the colleague standing next to them.
    await expect(chargeRateLimit(request, 'member_create', 'cashier-2')).resolves.toBeUndefined();
    await expect(chargeRateLimit(request, 'member_create', 'cashier-1')).rejects.toThrow(
      RateLimitedError,
    );
  });

  it('keys on the address when no scope is given', async () => {
    const mine = requestFrom('203.0.113.9');

    await spendAndRefuse(mine, 'approval_failure');

    // A different caller is unaffected — the bucket is the address, not the door.
    await expect(chargeRateLimit(requestFrom('203.0.113.10'), 'approval_failure')).resolves.toBeUndefined();
    await expect(chargeRateLimit(mine, 'approval_failure')).rejects.toThrow(RateLimitedError);
  });

  it('treats a dual-stack loopback and its IPv4 form as one caller', async () => {
    const mapped = requestFrom('::ffff:127.0.0.1');

    await spendAndRefuse(mapped, 'pair_attempt');

    await expect(chargeRateLimit(requestFrom('127.0.0.1'), 'pair_attempt')).rejects.toThrow(
      RateLimitedError,
    );
  });

  it('does not let a caller pick its own bucket with a forwarded header', async () => {
    await spendAndRefuse(requestFrom('198.51.100.7', '203.0.113.9'), 'pair_attempt');

    // The same caller, a different header: the bucket did not move.
    await expect(
      chargeRateLimit(requestFrom('198.51.100.7', '10.0.0.1'), 'pair_attempt'),
    ).rejects.toThrow(RateLimitedError);

    // While a caller our own proxy forwarded *is* its own bucket, which is the
    // whole reason the header is read at all.
    await expect(
      chargeRateLimit(requestFrom('127.0.0.1', '203.0.113.9'), 'pair_attempt'),
    ).resolves.toBeUndefined();
  });
});

describe('attempts that race for one bucket', () => {
  it('lets no more than the capacity through, however many spend it at once', async () => {
    const policy = RATE_LIMIT_POLICIES.member_create;
    const request = requestFrom('203.0.113.9');
    const attempts = policy.capacity * 2;

    /*
     * The claim ADR 0012 was written to make true. When the buckets were a `Map` in one
     * process this race had a single spender and nothing to prove; with the state in a
     * table, these are concurrent transactions on one row, and the only thing keeping
     * the count honest is the lock the upsert takes.
     *
     * A store that read and wrote without one lets several of them through on the same
     * token — which is how "each process is half as strict" shows up as a *number*
     * rather than a paragraph.
     */
    const allowed = await Promise.all(
      Array.from({ length: attempts }, () =>
        chargeRateLimit(request, 'member_create', 'cashier-1').then(
          () => true,
          () => false,
        ),
      ),
    );

    const through = allowed.filter(Boolean).length;

    // Exact, not a bound: refill is one token a minute, so earning an extra attempt
    // would take a race that ran for a minute, and none of the refused attempts can
    // have been a *store* failure — those resolve (`chargeRateLimit` fails open), which
    // is what makes this assertion catch a limiter that stopped limiting, not just one
    // that stopped locking.
    expect(through).toBe(policy.capacity);
  });
});

describe('what a trip writes down', () => {
  it('records one row for a burst, however many attempts follow it', async () => {
    const request = requestFrom('203.0.113.9');

    await spendAndRefuse(request, 'login_failure', 'cashier@shop.test');

    // Four more refused attempts — this is the attack continuing, not four events.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        chargeRateLimit(request, 'login_failure', 'cashier@shop.test'),
      ).rejects.toThrow(RateLimitedError);
    }

    const trail = await listAuditLogs({ action: 'rate_limited' });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.detail).toMatchObject({
      policy: 'login_failure',
      scope: 'cashier@shop.test',
      address: '203.0.113.9',
    });
  });

  it('names the door and the address, and nobody as the actor', async () => {
    await spendAndRefuse(requestFrom('203.0.113.9'), 'inbound_notification');

    const trail = await listAuditLogs({ action: 'rate_limited' });
    expect(trail[0]?.actor).toBeNull();
    expect(trail[0]?.detail?.policy).toBe('inbound_notification');
    expect(trail[0]?.detail?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not write a row for an attempt that was allowed', async () => {
    await chargeRateLimit(requestFrom('203.0.113.9'), 'pair_attempt');

    expect(await listAuditLogs({ action: 'rate_limited' })).toHaveLength(0);
  });
});

describe('the buckets themselves', () => {
  it('counts one bucket per caller, and forgets them on request', async () => {
    await chargeRateLimit(requestFrom('203.0.113.9'), 'pair_attempt');
    await chargeRateLimit(requestFrom('203.0.113.10'), 'pair_attempt');

    expect(await rateLimitBucketCount()).toBe(2);
    await resetRateLimits();
    expect(await rateLimitBucketCount()).toBe(0);
  });

  it('keeps a bucket in the database, where another process can see it', async () => {
    await chargeRateLimit(requestFrom('203.0.113.9'), 'member_create', 'cashier-1');

    const rows = await prisma.$queryRaw<{ bucket_key: string; tokens: number }[]>`
      SELECT "bucket_key", "tokens" FROM "rate_limit_buckets"
    `;

    // Reading the table directly is the observable that makes the limiter shared:
    // the spent attempt is in the row, not in the process that spent it, and the key
    // is the one the pure module composes — which is what lets a second process find
    // the same caller's attempts without being told about them.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bucket_key).toBe('member_create|203.0.113.9|cashier-1');
    expect(rows[0]?.tokens).toBe(RATE_LIMIT_POLICIES.member_create.capacity - 1);
  });

  it('still refuses after a restart, because nothing about a spent bucket is in the process', async () => {
    await spendAndRefuse(requestFrom('203.0.113.9'), 'member_create', 'cashier-1');

    /*
     * A restart is a fresh module instance, which is exactly what a limiter that
     * kept its buckets in a `Map` could not survive. Re-importing is the closest a
     * test can get to one, and it is an honest test of the property rather than of
     * the implementation: nothing in-process is carried across it.
     */
    vi.resetModules();
    const restarted = await import('@/lib/rate-limit');

    const refused = await restarted
      .chargeRateLimit(requestFrom('203.0.113.9'), 'member_create', 'cashier-1')
      .catch((error: unknown) => error);

    // Compared on the status rather than with `instanceof`, because the error class
    // is one of the things the restart replaced.
    expect((refused as { httpStatus?: number }).httpStatus).toBe(429);
  });

  it('would forget nothing that could still refuse, at the sweep`s age', async () => {
    // The sweep's safety rests on this: a bucket idle for the forget age has
    // refilled to full, so dropping it cannot let anybody through sooner than
    // waiting would have.
    const { FORGET_IDLE_AFTER_MS } = await import('@/lib/rate-limit');

    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(policy.windowMs, name).toBeLessThanOrEqual(FORGET_IDLE_AFTER_MS);
    }
  });
});afterAll(async () => {
  await prisma.$disconnect();
});
