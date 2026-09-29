/**
 * Where the attempt buckets live, and what happens when one runs out.
 *
 * The policy — how many, how fast, keyed by what — is pure and lives in
 * `rate-limit-policy.ts`. This file is the part that cannot be: storage, a clock,
 * and the one thing worth writing down when a caller is refused.
 *
 * **The buckets are rows in the shop's own database** (ADR 0012), which is the
 * change from the first version of this file. The trade it made was honest and
 * stated — one Node listener for one shop, so a `Map` was enough and a shared store
 * would mean Redis or a table for a limit that only has to survive a burst — and
 * both halves of it stopped holding. The deployment is no longer guaranteed to be a
 * single process, and two processes behind a load balancer are two limiters, each
 * half as strict as the configuration says. And "a restart forgets every bucket" is
 * not a footnote when it means a limiter whose strictness depends on how often the
 * shop restarts.
 *
 * Postgres rather than Redis, deliberately: the renter already runs it, it is
 * already where every other durable fact about the shop lives, and one query next to
 * the work these doors do anyway — a bcrypt compare, a shop row, a stock update — is
 * not a cost worth a second service to avoid.
 *
 * Nothing here is a *security boundary*, and that is still intentional. Every door it
 * guards refuses the wrong answer without it: a wrong password signs nobody in, a
 * wrong PIN issues no token, a wrong webhook secret writes no row. The limiter's job
 * is to make guessing slow, not to be the thing that stops it — which is why a bug
 * here can cost money in CPU and never in authority, and why a store that cannot be
 * reached lets the request through rather than turning a shop away (see `chargeRateLimit`).
 */
import { recordAudit } from './audit';
import { prisma } from './db';
import { RateLimitedError } from './errors';
import {
  RATE_LIMIT_POLICIES,
  bucketKey,
  clientAddress,
  decide,
  type Decision,
  type RateLimitPolicy,
  type RateLimitPolicyName,
} from './rate-limit-policy';

/**
 * The longest any policy's window is (`setup_attempt`, at an hour), which makes this
 * the age at which forgetting a bucket cannot change an answer: everything idle for
 * that long has refilled to full. A test asserts the policy table never grows a
 * window beyond it.
 *
 * It is also how often this process prunes, and that follows from the same sentence:
 * looking more often than this cannot delete a row the previous look could not, so
 * the sweep costs one `DELETE` an hour per process and the table holds at most two
 * hours of buckets.
 */
export const FORGET_IDLE_AFTER_MS = 60 * 60_000;

/** When this process last pruned. In memory on purpose: a missed sweep is a row. */
let lastPruneAt = 0;

/**
 * Spends one attempt for this request, or refuses it.
 *
 * Called *before* the work it guards, because the point is to not do the work. The
 * one exception is a door whose refusal is itself the thing being counted — a wrong
 * password, a wrong PIN — and those call it once the attempt has already failed
 * (`login` and `approvals` do exactly that). Charging every *successful* login
 * would mean an office behind one address could lock itself out on a Monday
 * morning, which is a limiter that teaches people to turn it off.
 *
 * `scope` narrows the bucket further than the caller's address: the login route
 * passes the identifier being tried, so guessing at one account spends that
 * account's bucket *and* the address's.
 */
export async function chargeRateLimit(
  request: Request,
  policy: RateLimitPolicyName,
  scope?: string,
): Promise<void> {
  const address = clientAddress(
    request.headers.get('x-client-address'),
    request.headers.get('x-forwarded-for'),
  );
  const key = bucketKey(policy, address, scope);

  let decision: Decision;
  try {
    decision = await spend(key, RATE_LIMIT_POLICIES[policy]);
  } catch {
    /*
     * A limiter that cannot reach its store lets the caller through, and this is the
     * one place in the application where swallowing an error is the *safer* answer.
     * The alternative is a database that is merely slow turning a wrong password
     * into a 500, on doors whose refusals are already decided by the domain — and
     * making the limiter load-bearing is exactly the thing ADR 0009 decision 7 says
     * it must never be. It also fails in the direction of the shop's own revenue:
     * the door this protects is a sale, a sign-in or a paid order.
     */
    return;
  }

  await pruneIfDue();

  if (decision.allowed) {
    return;
  }

  /*
   * Only the *first* refusal of a burst is recorded. A trail that took a row per
   * refused request would be a trail an attacker writes to at volume for free —
   * and the same reasoning already governs a wrong PIN, which is audited only when
   * it trips the lock (`supervisor.ts`). What an owner needs from this row is
   * "somebody started guessing at 09:14", not a thousand copies of it.
   *
   * The buckets being shared makes this stricter than it was: a row lock means one
   * process sees the transition from "not refusing" to "refusing", so two processes
   * cannot each write the same first refusal.
   */
  if (decision.tripped) {
    try {
      await recordAudit({
        action: 'rate_limited',
        detail: {
          policy,
          retryAfterSeconds: decision.retryAfterSeconds,
          address,
          /*
           * The attempted account, when there was one — the attacker's own input,
           * kept because "which account were they after" is the first question
           * anybody asks of a row like this.
           */
          ...(scope ? { scope } : {}),
        },
      });
    } catch {
      /*
       * The refusal stands whether or not the trail could be written.
       */
    }
  }

  throw new RateLimitedError(policy, decision.retryAfterSeconds);
}

/** What a bucket row reads back as, with the two timestamps as epoch milliseconds. */
interface BucketRow {
  tokens: number;
  updated_ms: number;
  refusing: boolean;
  now_ms: number;
}

/**
 * Spends one attempt from one bucket, atomically, wherever this process is.
 *
 * Two statements in one transaction, and both are load-bearing.
 *
 * **The upsert is how a bucket is created *and* how it is locked.** `ON CONFLICT DO
 * UPDATE` is the way to say "insert it, or take a row lock on the one already
 * there": a plain `SELECT … FOR UPDATE` finds nothing to lock the first time, and
 * two processes would both go on to insert. The lock is held to commit, so a second
 * process spending the same bucket waits for the first — which is the difference
 * between a limit as strict as it says and one twice as generous. The no-op update
 * (`SET bucket_key = EXCLUDED.bucket_key`) writes the value it already has; the
 * lock, and the returned row, are the point.
 *
 * **The clock is the database's.** `now()` is the transaction's own instant, and it
 * is used for both the decision and the row it writes, so every process reading one
 * bucket measures elapsed time against the same clock. Using `Date.now()` would
 * mean a process whose clock ran fast crediting everyone tokens nobody gave them —
 * and with a bucket shared between processes, "whose clock" becomes a question with
 * no answer.
 */
async function spend(key: string, policy: RateLimitPolicy): Promise<Decision> {
  return prisma.$transaction(async (tx) => {
    /*
     * The values are `fullBucket(policy, now())` written out, because SQL cannot call
     * the pure module: a caller nobody has refused yet arrives with every attempt
     * they have, which is what makes the first request never the one that pays for
     * the limiter.
     */
    const rows = await tx.$queryRaw<BucketRow[]>`
      INSERT INTO "rate_limit_buckets" ("bucket_key", "tokens", "updated_at", "refusing")
      VALUES (${key}, ${policy.capacity}::float8, now(), false)
      ON CONFLICT ("bucket_key") DO UPDATE SET "bucket_key" = EXCLUDED."bucket_key"
      RETURNING
        "tokens"::float8 AS tokens,
        (extract(epoch FROM "updated_at") * 1000)::float8 AS updated_ms,
        "refusing",
        (extract(epoch FROM now()) * 1000)::float8 AS now_ms
    `;

    const row = rows[0];
    if (!row) {
      // Unreachable: an upsert with a RETURNING clause that matched no row is a
      // transaction that did nothing, and failing loudly beats a silent full bucket.
      throw new Error('The rate limiter could not read back the bucket it just wrote');
    }

    const decision = decide(
      { tokens: row.tokens, updatedAt: row.updated_ms, refusing: row.refusing },
      policy,
      row.now_ms,
    );

    await tx.$executeRaw`
      UPDATE "rate_limit_buckets"
      SET "tokens" = ${decision.bucket.tokens}::float8,
          "updated_at" = now(),
          "refusing" = ${decision.bucket.refusing}
      WHERE "bucket_key" = ${key}
    `;

    return decision;
  });
}

/**
 * Forgets buckets idle long enough to have refilled.
 *
 * The in-process version swept a `Map` once it had ten thousand keys; the equivalent
 * here is a `DELETE` over a table that is normally a handful of rows, so it runs on
 * the same interval as the age it forgets at (see `FORGET_IDLE_AFTER_MS`) rather than
 * on a size threshold. `lastPruneAt` is set before the delete, so two callers racing
 * on it produce one sweep.
 *
 * Best-effort, and it has to be: housekeeping that failed is not a reason to refuse
 * a request. The consequence of a sweep that never runs is a table that grows, which
 * is a slow problem in a room with fast ones.
 */
async function pruneIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < FORGET_IDLE_AFTER_MS) {
    return;
  }
  lastPruneAt = now;

  try {
    await prisma.$executeRaw`
      DELETE FROM "rate_limit_buckets"
      WHERE "updated_at" < now() - make_interval(secs => ${FORGET_IDLE_AFTER_MS / 1000}::float8)
    `;
  } catch {
    // See above.
  }
}

/**
 * Empties every bucket.
 *
 * For tests, which cannot wait out a window; for an operator who wants the shop's
 * attempts forgiven after a lockout that was their own; and for the one runtime case
 * that used to need nothing — a process handed traffic it has no history for.
 */
export async function resetRateLimits(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "rate_limit_buckets"`;
}

/** How many buckets are being tracked. Diagnostics, and the sweep's own test. */
export async function rateLimitBucketCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: unknown }[]>`
    SELECT count(*) AS count FROM "rate_limit_buckets"
  `;
  return Number(rows[0]?.count ?? 0);
}
