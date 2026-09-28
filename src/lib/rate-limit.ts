/**
 * Where the attempt buckets live, and what happens when one runs out.
 *
 * The policy — how many, how fast, keyed by what — is pure and lives in
 * `rate-limit-policy.ts`. This file is the part that cannot be: a `Map`, a clock,
 * and the one thing worth writing down when a caller is refused.
 *
 * **Per process, in memory, and that is a deliberate trade rather than an
 * oversight.** This deployment is one Node process serving one shop (`src/server.ts`
 * is the only listener), so a shared store would mean a Redis or a table for a
 * limit that already only has to survive a burst. What it costs is stated plainly:
 * a restart forgets every bucket, and a deployment that grows a second process
 * behind a load balancer would have two independent limiters — each half as strict
 * as the configuration says. The limit a shop actually needs against a distributed
 * attack belongs in the reverse proxy in front of this, and this limiter is the
 * backstop that keeps one script from being able to guess its way in.
 *
 * Nothing here is a *security boundary* either, and that is intentional. Every
 * door it guards refuses the wrong answer without it: a wrong password signs
 * nobody in, a wrong PIN issues no token, and a wrong webhook secret writes no
 * row. The limiter's job is to make guessing slow, not to be the thing that stops
 * it — which is why a bug here can cost money in CPU and never in authority.
 */
import { recordAudit } from './audit';
import { RateLimitedError } from './errors';
import {
  RATE_LIMIT_POLICIES,
  clientAddress,
  decide,
  type Bucket,
  type RateLimitPolicyName,
} from './rate-limit-policy';

const buckets = new Map<string, Bucket>();

/**
 * The longest any policy's window is (`setup_attempt`, at an hour), which makes
 * this the age at which forgetting a bucket cannot change an answer: everything
 * idle for that long has refilled to full. A test asserts the policy table never
 * grows a window beyond it, so the sweep cannot quietly start favouring a caller.
 */
export const FORGET_IDLE_AFTER_MS = 60 * 60_000;

/** Start sweeping once the map is this big — a burst from many addresses. */
const SWEEP_THRESHOLD = 10_000;

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
  const now = Date.now();
  const address = clientAddress(
    request.headers.get('x-client-address'),
    request.headers.get('x-forwarded-for'),
  );
  const key = scope ? `${policy}|${address}|${scope}` : `${policy}|${address}`;

  const decision = decide(buckets.get(key), RATE_LIMIT_POLICIES[policy], now);
  buckets.set(key, decision.bucket);
  sweepIfLarge(now);

  if (decision.allowed) {
    return;
  }

  /*
   * Only the *first* refusal of a burst is recorded. A trail that took a row per
   * refused request would be a trail an attacker writes to at volume for free —
   * and the same reasoning already governs a wrong PIN, which is audited only when
   * it trips the lock (`supervisor.ts`). What an owner needs from this row is
   * "somebody started guessing at 09:14", not a thousand copies of it.
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
       * The refusal stands whether or not the trail could be written. Swallowing
       * is the right answer here specifically because the alternative is worse:
       * a database that is merely slow would turn a 429 into a 500, which tells
       * the caller nothing and hides the limit that is working fine.
       */
    }
  }

  throw new RateLimitedError(policy, decision.retryAfterSeconds);
}

/**
 * Forgets buckets that have been idle long enough to have refilled. Cheap, and
 * only when the map has genuinely grown — the ordinary case is a shop with a
 * handful of addresses, where this never runs at all.
 */
function sweepIfLarge(now: number): void {
  if (buckets.size <= SWEEP_THRESHOLD) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt >= FORGET_IDLE_AFTER_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * Empties every bucket. For tests, which cannot wait out a window, and for the
 * one legitimate runtime case: a process that has just come back from a restart
 * and is about to be handed traffic it has no history for — which is what the map
 * already looks like.
 */
export function resetRateLimits(): void {
  buckets.clear();
}

/** How many buckets are being tracked. Diagnostics, and the sweep's own test. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
