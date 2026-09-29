import { describe, expect, it } from 'vitest';

import {
  MAX_BUCKET_KEY_LENGTH,
  RATE_LIMIT_POLICIES,
  bucketKey,
  clientAddress,
  decide,
  fullBucket,
  isPrivateAddress,
  type Bucket,
} from '../src/lib/rate-limit-policy';

const POLICY = { capacity: 3, windowMs: 3_000 };
const START = 1_700_000_000_000;

/** Spends `count` attempts back to back, carrying the bucket forward. */
function spend(
  count: number,
  policy = POLICY,
  from?: Bucket,
  now = START,
): { decisions: ReturnType<typeof decide>[]; bucket: Bucket } {
  const decisions: ReturnType<typeof decide>[] = [];
  let bucket = from;
  for (let index = 0; index < count; index += 1) {
    const decision = decide(bucket, policy, now);
    decisions.push(decision);
    bucket = decision.bucket;
  }
  return { decisions, bucket: bucket! };
}

describe('a token bucket', () => {
  it('lets a caller with no history spend the whole capacity', () => {
    const { decisions } = spend(3);

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true]);
    expect(decisions[0]?.remaining).toBe(2);
    expect(decisions[2]?.remaining).toBe(0);
  });

  it('refuses the attempt after the capacity, and says how long to wait', () => {
    const { decisions } = spend(4);

    expect(decisions[3]?.allowed).toBe(false);
    // One token of a three-per-three-seconds bucket: a second, rounded up.
    expect(decisions[3]?.retryAfterSeconds).toBe(1);
    expect(decisions[3]?.limit).toBe(3);
  });

  it('never answers "wait zero seconds", which would be a client busy-looping', () => {
    const { bucket } = spend(3);
    const refused = decide(bucket, POLICY, START);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('credits the refill over time rather than resetting a window', () => {
    const { bucket } = spend(3);

    // A third of the window is one token back.
    expect(decide(bucket, POLICY, START + 1_000).allowed).toBe(true);
    expect(decide(bucket, POLICY, START + 999).allowed).toBe(false);
  });

  it('refills no further than full, however long the caller waits', () => {
    const drained: Bucket = { tokens: 0, updatedAt: START, refusing: true };
    const later = decide(drained, POLICY, START + 24 * 60 * 60_000);

    // Full, less the attempt this call just spent — not a token bank to hoard.
    expect(later.allowed).toBe(true);
    expect(later.bucket.tokens).toBe(POLICY.capacity - 1);
  });

  it('keeps a fractional remainder instead of rounding the caller up', () => {
    const { bucket } = spend(3);

    // Half a window refills half the capacity; spending that leaves half a token.
    const half = decide(bucket, POLICY, START + 1_500);
    expect(half.allowed).toBe(true);
    expect(half.bucket.tokens).toBeCloseTo(0.5, 6);
    expect(half.remaining).toBe(0);
    expect(decide(half.bucket, POLICY, START + 1_500).allowed).toBe(false);
  });

  it('marks the first refusal of a burst and nothing after it', () => {
    const { bucket } = spend(3);

    const first = decide(bucket, POLICY, START);
    const second = decide(first.bucket, POLICY, START);
    const third = decide(second.bucket, POLICY, START);

    expect(first).toMatchObject({ allowed: false, tripped: true });
    expect(second).toMatchObject({ allowed: false, tripped: false });
    expect(third).toMatchObject({ allowed: false, tripped: false });
  });

  it('hands a caller with no history exactly the bucket the store would have created', () => {
    const created = fullBucket(POLICY, START);

    // The store writes this shape into the row it inserts (`rate-limit.ts`), so the
    // two have to agree or a first-time caller would be charged twice — once by the
    // INSERT and once by the decision that reads it back.
    expect(created).toEqual({ tokens: POLICY.capacity, updatedAt: START, refusing: false });
    expect(decide(created, POLICY, START)).toEqual(decide(undefined, POLICY, START));
  });

  it('marks a new burst again once the caller has been let back in', () => {
    const { bucket } = spend(3);
    const refused = decide(bucket, POLICY, START);

    // A full window later the bucket is full again, so this is a fresh burst of
    // three and the fourth attempt is a new trip rather than the old one.
    const { decisions } = spend(3, POLICY, refused.bucket, START + 3_000);
    const refusedAgain = decide(decisions[2]!.bucket, POLICY, START + 3_000);

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true]);
    expect(refusedAgain).toMatchObject({ allowed: false, tripped: true });
  });

  it('does not go backwards when a clock steps back', () => {
    const loaded = decide(undefined, POLICY, START).bucket;
    const backwards = decide({ ...loaded, tokens: 0 }, POLICY, START - 60_000);

    expect(backwards.allowed).toBe(false);
    expect(backwards.bucket.tokens).toBe(0);
  });
});

describe('the policy table', () => {
  it('gives every door a named policy with a usable capacity', () => {
    const names = Object.keys(RATE_LIMIT_POLICIES);

    expect(names).toEqual([
      'login_failure',
      'login_flood',
      'approval_failure',
      'setup_attempt',
      'pair_attempt',
      'inbound_notification',
      'member_create',
    ]);

    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(policy.capacity, name).toBeGreaterThan(0);
      expect(policy.windowMs, name).toBeGreaterThan(0);
      expect(Number.isInteger(policy.capacity), name).toBe(true);
    }
  });

  it('lets a single shop day through the login door without ever tripping', () => {
    const { login_failure: perAccount, login_flood: perAddress } = RATE_LIMIT_POLICIES;

    expect(perAccount.capacity).toBeGreaterThanOrEqual(5);
    expect(perAddress.capacity).toBeGreaterThan(perAccount.capacity);
  });

  it('caps a replayed bridge well above a real mailbox, and well below a loop', () => {
    const policy = RATE_LIMIT_POLICIES.inbound_notification;

    expect(policy.capacity).toBeGreaterThanOrEqual(60);
    expect(policy.capacity).toBeLessThan(1_000);
  });

  it('caps enrolments as a burst a person cannot type, not as a daily quota', () => {
    const policy = RATE_LIMIT_POLICIES.member_create;

    // The whole point of the door: a handful of sign-ups back to back is normal,
    // and a loop is not. It has to be a burst ceiling rather than a low quota, or
    // the shop switches it off on its first busy Saturday.
    expect(policy.capacity).toBeGreaterThanOrEqual(5);
    expect(policy.capacity).toBeLessThanOrEqual(20);

    // And it must refill in minutes rather than hours: at the steady rate, one
    // enrolment a minute keeps a queue moving all day, so the ceiling is only ever
    // met by somebody who is not typing.
    expect(policy.windowMs / policy.capacity).toBeLessThanOrEqual(2 * 60_000);
  });
});

describe('deciding who a request is from', () => {
  it('uses the socket address when nothing forwarded the request', () => {
    expect(clientAddress('203.0.113.9', null)).toBe('203.0.113.9');
  });

  it('normalises a dual-stack loopback to the IPv4 form', () => {
    expect(clientAddress('::ffff:127.0.0.1', null)).toBe('127.0.0.1');
  });

  it('trusts a forwarded address when it came from our own proxy', () => {
    expect(clientAddress('127.0.0.1', '203.0.113.9, 10.0.0.1')).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.5', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores a forwarded address from a caller that could not be a proxy', () => {
    // Otherwise any client picks its own bucket by sending one header.
    expect(clientAddress('203.0.113.9', '10.0.0.1')).toBe('203.0.113.9');
  });

  it('falls back to the socket when a forged header carries nothing usable', () => {
    expect(clientAddress('127.0.0.1', '   ')).toBe('127.0.0.1');
    expect(clientAddress('127.0.0.1', ',')).toBe('127.0.0.1');
  });

  it('names an unknown caller rather than sharing an empty key', () => {
    expect(clientAddress(null, null)).toBe('unknown');
    expect(clientAddress('', '')).toBe('unknown');
  });

  it('composes the bucket key from the door, the caller and the scope', () => {
    expect(bucketKey('member_create', '203.0.113.9')).toBe('member_create|203.0.113.9');
    expect(bucketKey('login_failure', '203.0.113.9', 'someone@shop.test')).toBe(
      'login_failure|203.0.113.9|someone@shop.test',
    );
  });

  it('caps an oversized key, so an absurd identifier cannot break the door it spends', () => {
    const key = bucketKey('login_failure', '203.0.113.9', 'x'.repeat(5_000));

    expect(key).toHaveLength(MAX_BUCKET_KEY_LENGTH);
    // Truncated rather than hashed, and the direction is deliberate: two absurd
    // identifiers sharing a prefix share a bucket, so the caller is limited a little
    // sooner instead of walking around the limit that was meant to count them.
    expect(bucketKey('login_failure', '203.0.113.9', 'x'.repeat(9_000))).toBe(key);
  });
});

describe('which addresses count as our own network', () => {
  it('accepts loopback, link-local and RFC 1918', () => {
    for (const address of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.9', '192.168.1.4', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('refuses a public address, including one that only looks private', () => {
    for (const address of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', '192.169.0.1', '2001:db8::1', '']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
