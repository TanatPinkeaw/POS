/**
 * How hard a caller may push, and how that is worked out.
 *
 * Every endpoint in this app enforces its own permissions, and the sensitive ones
 * already refuse a second guess: a supervisor PIN locks after five wrong tries, and
 * a wrong password signs nobody in. What none of them bounded is *volume* — ten
 * thousand wrong PINs a second is a thousand accounts times five tries, and a
 * password spray across every phone number in an address book is not a lockout at
 * all. That is the gap this fills, and it is deliberately narrow: the doors that
 * need no session, the two secrets worth guessing, and one signed-in write that
 * mints a credential rather than a sale.
 *
 * The state is a **token bucket**, and the shape was chosen for what it does at
 * the edges. A caller with no history arrives with a full bucket and is unaffected;
 * a caller that fires a burst spends it and is then let through at the refill rate
 * rather than being locked out for a fixed window; and nothing has to be *reset*,
 * so a shop that trips the limit at 9:05 is not still serving a refusal at 9:20 on
 * the strength of one badly-timed counter. A fixed window — "ten per fifteen
 * minutes, reset on the quarter hour" — would allow twenty in a second across the
 * boundary and forget the first ten the moment the clock turned.
 *
 * Numbers live here and nowhere else, so a limit is one line to read, one line to
 * change, and one line to argue about. Refill is continuous
 * (`capacity ÷ windowMs` tokens per ms) rather than stepwise, which is what makes
 * "one attempt every ninety seconds is fine, sixty in a second is not" expressible
 * with two numbers.
 */

/** The doors this guards. Each names *what is being counted*, not who called it. */
export type RateLimitPolicyName =
  | 'login_failure'
  | 'login_flood'
  | 'approval_failure'
  | 'setup_attempt'
  | 'pair_attempt'
  | 'inbound_notification'
  | 'member_create'
  | 'otp_send_number'
  | 'otp_send_address'
  | 'consignment_offer'
  | 'line_signin'
  | 'line_link'
  | 'line_webhook';

export interface RateLimitPolicy {
  /** Attempts that may be spent back to back, from an idle caller. */
  capacity: number;
  /** How long the whole bucket takes to refill, in milliseconds. */
  windowMs: number;
}

/**
 * The longest a bucket key may be, in characters.
 *
 * Not decoration: since ADR 0012 the key is a *primary key in a table*, and a
 * bounded key is what stops an oversized one from being a failed insert instead of
 * a refusal. `login_failure` scopes by whatever identifier was typed, and
 * `loginSchema` puts no ceiling on that — so without a cap here, a caller posting a
 * megabyte of identifier could break the limiter rather than be counted by it.
 *
 * Truncated rather than hashed, and the direction is the point: two absurd
 * identifiers sharing a prefix share a bucket, so the worst case is somebody
 * limited slightly sooner than their own attempts alone would have. The column it
 * lands in is wider (see the migration) so this can be raised without one.
 */
export const MAX_BUCKET_KEY_LENGTH = 200;

/**
 * The row a caller's attempts are counted in: the door, who they are, and whatever
 * the door narrows them by.
 *
 * Here rather than in the store because ADR 0009 decision 1 already puts the key
 * derivation in the pure module — it is policy, not storage: which callers share a
 * bucket is the decision, and where the row lives is not.
 */
export function bucketKey(
  name: RateLimitPolicyName,
  address: string,
  scope?: string,
): string {
  const key = scope ? `${name}|${address}|${scope}` : `${name}|${address}`;
  return key.slice(0, MAX_BUCKET_KEY_LENGTH);
}

/**
 * A bucket nobody has spent from yet: full, at rest, and not refusing.
 *
 * Named because two places have to agree on it — `decide` for a caller with no
 * history, and the insert that creates a row for one (`rate-limit.ts`).
 */
export function fullBucket(policy: RateLimitPolicy, now: number): Bucket {
  return { tokens: policy.capacity, updatedAt: now, refusing: false };
}

/**
 * The limits themselves.
 *
 * Every one of them is set to be invisible in normal use and only reachable by
 * something that is not a shop: a cashier mistyping a password ten times in
 * fifteen minutes has a worse problem than the limiter, whereas a password spray
 * does exactly that on purpose. That asymmetry is the whole design goal — a limit
 * a busy Saturday can hit is a limit that gets switched off.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  /**
   * Wrong passwords for one account, from one address. Keyed by both, because an
   * account is what is being guessed at and the address is how a single attacker
   * is recognised as one.
   */
  login_failure: { capacity: 10, windowMs: 15 * 60_000 },
  /**
   * Wrong passwords from one address, whatever the account. The companion to
   * `login_failure`, and the reason varying the identifier does not walk around
   * it: this one is not per account, so spraying a list of phone numbers spends
   * *this* bucket.
   */
  login_flood: { capacity: 60, windowMs: 15 * 60_000 },
  /**
   * Wrong supervisor PINs from one address. The database already locks one
   * admin's PIN after five tries (`supervisor.ts`); what that cannot see is an
   * attacker walking the *list* of admins, five tries each.
   */
  approval_failure: { capacity: 20, windowMs: 15 * 60_000 },
  /**
   * The setup wizard. Unauthenticated by necessity — it is what creates the first
   * administrator — and it writes a shop row, so it is the most valuable
   * unauthenticated target in the app.
   */
  setup_attempt: { capacity: 10, windowMs: 60 * 60_000 },
  /**
   * Display pairing codes. A six-digit code with a short life is not a secret an
   * attacker can read, but it is one they can walk through, and the display that
   * owns it is on a wall in the shop.
   */
  pair_attempt: { capacity: 20, windowMs: 15 * 60_000 },
  /**
   * Bank notifications. The only policy here that is *not* about guessing: a
   * bridge posts every message the mailbox holds, and the cap exists so a
   * misconfigured one that replays its whole inbox in a loop cannot fill the
   * table faster than a person can notice.
   */
  inbound_notification: { capacity: 120, windowMs: 60_000 },
  /**
   * Enrolling customers — the one policy here on a door that wants a session
   * (ADR 0011 §6).
   *
   * It is the exception because of what the door *makes*: every call mints a
   * durable credential that can reserve stock without paying for it, and pays for a
   * bcrypt hash to do it, so a loop against it is neither free nor harmless. A sale
   * is not counted, and that is the point: it is the revenue the shop wants.
   *
   * Keyed by the signed-in account rather than by the address, and that is the
   * point of the scope: two cashiers on the shop's one wifi are two people, and
   * neither should be able to spend the other's budget. It also means signing out
   * and back in does not mint a fresh bucket — the budget belongs to the account.
   *
   * Ten back to back, then one a minute. A person cannot type ten sign-ups into a
   * form without pausing, and a queue keeps moving at one a minute all day, so the
   * ceiling is invisible at the counter and still stops a script.
   */
  member_create: { capacity: 10, windowMs: 10 * 60_000 },
  /**
   * Sending an OTP to one number, from one address (ADR 0020 §5). Keyed by both,
   * like `login_failure`: the number is what is being messaged and the address is
   * how one attacker is recognised. Three back to back is a retry or two; a fourth
   * in a quarter hour is somebody making the shop pay to text a stranger.
   */
  otp_send_number: { capacity: 3, windowMs: 15 * 60_000 },
  /**
   * Sending OTPs from one address, whatever the number. The companion to
   * `otp_send_number`, and the reason varying the number does not walk around it:
   * this one is not per number, so walking a list of numbers spends *this* bucket.
   * Sending is unauthenticated and costs money per attempt, which is exactly the
   * shape a limiter exists for.
   */
  otp_send_address: { capacity: 10, windowMs: 15 * 60_000 },
  /**
   * A member offering their own goods for consignment (ADR 0025). Keyed by the
   * account rather than the address, exactly like `member_create`: two members on
   * the shop's one wifi are two people, and neither should spend the other's budget.
   *
   * It exists for the same reason that one does — what it makes is durable and an
   * owner has to work through it — and the ceiling is the same shape. Somebody
   * offering a tray of things to the shop pauses to photograph it and to type; ten
   * back to back then one a minute is invisible to that person and stops a script
   * that has mistaken a retry loop for an offer.
   */
  consignment_offer: { capacity: 10, windowMs: 10 * 60_000 },
  /*
   * The LINE door (ADR 0030). Keyed by the address alone: the token a caller
   * presents is either genuinely LINE's or it is refused before anything else
   * happens, so there is no per-account scope worth taking — the walk itself is
   * what is counted. Same shape as `pair_attempt`: a door that answers a wrong
   * credential for free, so the ceiling exists to make walking it slow.
   */
  line_signin: { capacity: 10, windowMs: 15 * 60_000 },
  /*
   * Finishing a first LINE sign-in: an OTP is consumed on the success path, but
   * the *attempts* are what cost — each one is a bcrypt compare inside the
   * challenge's own attempt budget plus a JWT verification, and a script walking
   * the code space is exactly what a limiter exists to slow. The same ceiling as
   * `otp_send_address`, because the two doors are walked by the same screen.
   */
  line_link: { capacity: 10, windowMs: 15 * 60_000 },
  /*
   * The webhook LINE's platform posts (ADR 0030 §4). Signature-checked before
   * anything is written, so a caller without the secret gains nothing by
   * reaching the door — but an unauthenticated door that writes rows is a
   * row-filler's door otherwise, and the ceiling turns a flood into a refusal
   * before the signature work runs at volume.
   */
  line_webhook: { capacity: 60, windowMs: 60_000 },
};

/** A caller's bucket, as it stands after the last decision about it. */
export interface Bucket {
  /** Fractional: refill is continuous, not stepwise. */
  tokens: number;
  /** When `tokens` was last written, so elapsed time can be credited. */
  updatedAt: number;
  /**
   * Whether the previous decision was a refusal. Kept so the *first* refusal of a
   * burst can be told apart from the thousandth — the first one is worth writing
   * down, and the rest are the attack continuing.
   */
  refusing: boolean;
}

export interface Decision {
  allowed: boolean;
  /** The bucket to store back. */
  bucket: Bucket;
  /** The policy's capacity, so a response can say what the ceiling is. */
  limit: number;
  /** Whole attempts left after this one, for a header or a message. */
  remaining: number;
  /** Zero when allowed; otherwise how long until one attempt would be allowed. */
  retryAfterSeconds: number;
  /**
   * True only when this is the first refusal after a usable state. The trail
   * records these and nothing else (see `rate-limit.ts`).
   */
  tripped: boolean;
}

/**
 * Spends one attempt for a caller, given whatever is known about them.
 *
 * Pure: no clock of its own, no storage, no I/O. `now` is a parameter so the
 * refill can be reasoned about — and tested — without waiting for it. The caller
 * owns the map, because *where* the buckets live is a deployment question (see
 * `rate-limit.ts`) and not a property of the policy.
 *
 * A first-time caller arrives with a full bucket rather than an empty one: the
 * limiter is there to stop the tenth thousand request, and making the first one
 * pay for it would be a limiter that breaks the shop to protect it.
 */
export function decide(
  previous: Bucket | undefined,
  policy: RateLimitPolicy,
  now: number,
): Decision {
  const bucket = previous ?? fullBucket(policy, now);

  const elapsed = Math.max(0, now - bucket.updatedAt);
  const perMs = policy.capacity / policy.windowMs;
  const tokens = Math.min(policy.capacity, bucket.tokens + elapsed * perMs);

  const allowed = tokens >= 1;
  const next: Bucket = {
    tokens: allowed ? tokens - 1 : tokens,
    updatedAt: now,
    refusing: !allowed,
  };

  /*
   * `previous?.refusing` and not `bucket.refusing`, which are the same thing here
   * but read differently on purpose: the question is whether the *last* decision
   * already refused, and a caller with no history has not.
   */
  const tripped = !allowed && !(previous?.refusing ?? false);

  return {
    allowed,
    bucket: next,
    limit: policy.capacity,
    remaining: Math.floor(next.tokens),
    retryAfterSeconds: allowed ? 0 : secondsUntilOneToken(tokens, policy),
    tripped,
  };
}

/**
 * A whole number of seconds, rounded up, and never zero: a caller told to wait
 * "0 seconds" tries again immediately, which is how a client turns a soft refusal
 * into a busy loop.
 */
function secondsUntilOneToken(tokens: number, policy: RateLimitPolicy): number {
  const perMs = policy.capacity / policy.windowMs;
  return Math.max(1, Math.ceil((1 - tokens) / perMs / 1000));
}

/**
 * Who a request is from.
 *
 * Two inputs, and the order between them is the whole point. The **socket
 * address** is the one thing a caller cannot choose, so it is the default and the
 * fallback. `X-Forwarded-For` is honoured only when the socket itself is a private
 * or loopback address, which is the shape of a shop running a reverse proxy on the
 * same host: trusting the header unconditionally would let any caller pick their
 * own bucket by sending one, and ignoring it entirely would make every request
 * behind that proxy share the proxy's bucket and one customer able to lock out the
 * whole shop.
 *
 * The first entry is the origin client; the rest are the chain of proxies. Only the
 * first is read, because the chain is only as trustworthy as its length and nothing
 * here counts hops.
 */
export function clientAddress(socketAddress: string | null, forwardedFor: string | null): string {
  const socket = normaliseAddress(socketAddress);

  if (forwardedFor) {
    const first = normaliseAddress(forwardedFor.split(',')[0] ?? null);
    if (first && isPrivateAddress(socket)) {
      return first;
    }
  }

  return socket || 'unknown';
}

/**
 * Normalises an address to the form a bucket key should use.
 *
 * Node reports a loopback connection on a dual-stack listener as
 * `::ffff:127.0.0.1`, and a bucket key of `::ffff:127.0.0.1` and one of
 * `127.0.0.1` would be two keys for one caller — which is exactly how a limiter
 * quietly stops working after a restart underneath a different stack.
 */
function normaliseAddress(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') {
    return '';
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return mapped ? mapped[1]! : value;
}

/** Loopback, link-local or RFC 1918 — i.e. plausibly a proxy we run ourselves. */
export function isPrivateAddress(address: string): boolean {
  if (address === '') {
    return false;
  }

  if (address === '::1' || address === 'localhost') {
    return true;
  }
  // fe80::/10 link-local and fc00::/7 unique-local, compared case-insensitively.
  const lower = address.toLowerCase();
  if (/^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)) {
    return true;
  }

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!octets) {
    return false;
  }
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
