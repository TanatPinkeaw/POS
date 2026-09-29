# ADR 0009 — A limiter on the doors that need no session

**Status:** accepted (2026-09-28)
**Context:** ADR 0004 decision 5 gave the dangerous till actions a supervisor PIN, and
`supervisor.ts` locks that PIN after five wrong tries. That covers a *person* guessing
at one admin. It does not cover volume: ten thousand wrong PINs a second is a thousand
admins times five tries each, a password spray across a phone book is not a lockout at
all, and the webhook secret was a comparison an unauthenticated caller could repeat as
fast as they could open sockets. Every endpoint here already refuses the wrong answer —
what none of them bounded was how many times it could be asked.

## Decisions

### 1. The policy is pure, and the memory is in the process

`src/lib/rate-limit-policy.ts` holds the numbers, the key derivation and the decision —
no clock of its own, no storage, no I/O — so a limit can be reasoned about and tested
without waiting fifteen minutes for it. `src/lib/rate-limit.ts` is the part that cannot
be pure: a `Map`, `Date.now()`, and the one row worth writing when a caller is refused.

In memory, per process, and stated plainly rather than hidden: this deployment is one
Node listener for one shop (`src/server.ts`), so a shared store would mean Redis or a
table for a limit that only has to survive a burst. The costs are real and named: a
restart forgets every bucket, and a deployment that grew a second process behind a load
balancer would have two independent limiters — each half as strict as configured. A
limit against a *distributed* attack belongs in the reverse proxy in front of this; this
is the backstop that stops one script from guessing its way in.

### 2. A token bucket, not a fixed window

A caller with no history arrives with a full bucket, so the first request is never the
one that pays for the limiter. A burst spends the bucket and is then let through at the
refill rate rather than being locked out until a clock turns; and nothing has to be
*reset*, which is what a fixed window gets wrong twice — twenty attempts across a
boundary, and a shop still being refused at 9:20 for something that happened at 9:05.

Refill is continuous (`capacity ÷ windowMs`), which is what makes "one attempt every
ninety seconds is fine, sixty in a second is not" expressible in two numbers rather than
a data structure.

### 3. The doors, and what a bucket is keyed by

Six of them, and the scope is the point:

| Door | Policy | Keyed by |
| --- | --- | --- |
| `POST /api/v1/auth/login` (failures) | 10 / 15 min, plus 60 / 15 min | address **and** identifier; address |
| `POST /api/v1/pos/approvals` (failures) | 20 / 15 min | address |
| `POST /api/v1/setup` | 10 / 1 hour | address |
| `POST /api/v1/display/pair` | 20 / 15 min | address |
| `POST /api/v1/payments/inbound` | 120 / 1 min | address |
| `POST /api/v1/members` (ADR 0011 §6) | 10 / 10 min | address **and** the signed-in account |

Two buckets on the login route, because they answer two different questions:
`login_failure` is "is this account being guessed at" — keyed by the address *and* the
identifier, so one customer cannot lock out a colleague standing beside them — and
`login_flood` is "is this door being hammered", which is what a spray across many
identifiers spends.

**A signed-in till is not limited**, deliberately. A cashier who can outrun the API has
a performance problem, not a security one, and the screen they are on is the shop's own
revenue — a limiter there is a limiter that gets switched off. The doors that need no
session, plus the two secrets worth guessing, is the honest line — with one exception
added afterwards and argued on its own terms.

**The exception is customer enrolment** (ADR 0011 §6), and the distinction is what the
call *makes* rather than who makes it: a sale is revenue the shop wants, whereas
`POST /api/v1/members` mints a credential that can reserve stock without paying for it
and pays for a bcrypt hash to do so. Ten back to back, then one a minute, keyed by the
signed-in account — so two tills on the shop's one wifi are two budgets, and an
operator cannot mint a fresh bucket by signing out. Nothing a person types into a
sign-up form reaches ten.

Two session-less endpoints are therefore *excluded*, and that is a decision rather than
an oversight. `GET /api/v1/display/state` carries a paired device token rather than a
session and is fetched whenever a screen reconnects — limiting it would mean a display
that lost the network is refused until it gives up, which is the failure mode a limiter
is not supposed to introduce. `GET /api/v1/auth/me` answers "who am I" for the shell and
writes nothing. Neither guesses at a secret; both are read-only.

### 4. Charged on failure where failing is the thing counted

Login and approvals charge *after* the attempt has already failed, which is the
difference between a limiter that protects a shop and one that locks out an office on a
Monday morning: charging every successful sign-in would mean one shared address behind a
counter could exhaust itself logging in at nine o'clock. Setup, pairing, the webhook and
customer enrolment charge first, because there the attempt *is* the thing being counted
— for the webhook, the comparison is what the caller is guessing at, and for enrolment
it is the credential a loop would produce.

### 5. Who a request is from is the socket, and only sometimes the header

`clientAddress` takes the address the socket reports, falling back to nothing else.
`X-Forwarded-For` is honoured **only when the socket itself is a private address** —
the shape of a shop running a proxy on the same host. Trusting it unconditionally would
let any caller choose its own bucket by sending a header; ignoring it entirely would
make every request behind that proxy share one bucket, so one customer could lock the
shop out.

`src/server.ts` stamps `x-client-address` onto every request from `socket.remoteAddress`
*before* Next builds its `Request`, overwriting anything the caller sent: there is
exactly one place that knows the peer, and it is not the caller. Dual-stack loopback is
normalised (`::ffff:127.0.0.1` → `127.0.0.1`) because two keys for one caller is how a
limiter quietly stops working.

### 6. Only the first refusal of a burst is written down

`audit_action` gains `rate_limited`, and a burst produces **one** row. This is the same
reasoning that already governs a wrong PIN — audited when it trips the lock, not per
attempt (`supervisor.ts`) — and it matters more here, because this is the one endpoint
an unauthenticated caller can make write to the trail: a row per refusal would be a free
amplifier pointed at the audit table. The row carries the policy, the address, and the
attempted identifier when there was one, because "which account were they after" is the
first question anybody asks of it.

A failure to write that row does not turn a 429 into a 500 — the refusal stands whether
or not the trail could record it.

### 7. The limiter is not a security boundary

Every door it guards refuses the wrong answer without it: a wrong password signs nobody
in, a wrong PIN issues no token, a wrong webhook secret writes no row. The limiter's job
is to make guessing slow, not to be the thing that stops it — which is why the whole
feature can be deleted and the worst outcome is a slower attack rather than an open door.

## Consequences

- A password spray, a PIN spray across the admin list, and a brute-forced webhook secret
  all become slow, and all three leave one readable row saying they started.
- Buckets are per process, so `npm run acceptance` and a restarted server start clean.
  Nothing in the shop's normal day reaches any of these ceilings.
- The limiter's numbers are one table in a pure module, so tuning one is a one-line
  change with a test that pins the arithmetic rather than the number.
- `Retry-After` is not sent as a header; the wait is in the error envelope's
  `retryAfterSeconds`, because that envelope is what every client here already parses.

## Known gaps, stated rather than discovered

- **No limit on authenticated traffic**, apart from customer enrolment. Decision 3,
  and the exception is argued in ADR 0011 §6. A sale, a refund and a stock adjustment
  are all still uncounted, which is the position decision 3 takes on purpose.
- **Nothing survives a restart, and nothing is shared between processes.** Decision 1.
- **No per-account lockout of its own.** A password may be guessed ten times per fifteen
  minutes for one account, indefinitely. A real lockout needs an unlock path a shop can
  perform without a database console, which is a screen rather than a limiter.
- **The address is the only identity available.** A shop whose customers share one NAT
  shares one bucket; that is why the login ceiling is high enough to be invisible.
