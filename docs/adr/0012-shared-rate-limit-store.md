# ADR 0012 — The limiter's buckets live in the shop's database

**Status:** accepted (2026-09-29)
**Context:** ADR 0009 decision 1 kept the limiter's buckets in a `Map` in the process,
and named the trade rather than hiding it: this deployment is one Node listener for one
shop, so a shared store would mean Redis or a table for a limit that only has to survive
a burst — and the costs were stated plainly. The costs are what arrived. A deployment
that grows a second process behind a load balancer is two independent limiters, **each
half as strict as the configuration says**, and a restart forgets every bucket, so the
limiter's strictness is a property of the shop's deployment and uptime that nobody can
write in a runbook.

This supersedes ADR 0009 decision 1 and closes its first known gap. Nothing else in
that ADR changes: the policy is still pure, the doors are still the same doors, and the
limiter is still not a security boundary.

## Decisions

### 1. Postgres, not Redis, and not a new dependency

The renter already runs PostgreSQL. Every durable fact about the shop is already in it,
it is already backed up, and it is already the thing to explain during an install. A
second service would be a new dependency, a new backup, a new failure mode and a new
paragraph in the onboarding guide — for a limit that only has to survive a burst. A
bucket is one row.

What a shared store buys is what the in-process version could not: a restart that
forgets nothing, and two processes enforcing one limit between them rather than one
each.

### 2. Two statements in one transaction: insert-or-lock, then decide

`INSERT … ON CONFLICT DO UPDATE` is how a bucket is created *and* how it is locked —
the standard way to say "insert it, or take a row lock on the one already there". A
plain `SELECT … FOR UPDATE` reads well and is wrong here: the first time a caller is
seen there is nothing to lock, so two processes would both find nothing and both go on
to insert, and one of the two attempts would vanish. The no-op update writes the value
the row already has; the lock and the returned row are the point. The lock is held to
commit, so a second process spending the same bucket waits for the first.

The arithmetic is still `decide()`, unchanged, still pure and still unit-tested with the
same twenty-odd tests. The store is the only new thing, and the temptation this
decision refuses is the obvious one: expressing the refill in SQL would be faster and
would be **a second implementation of the numbers**, which this codebase has now
avoided twice (`phone.ts`, `password.ts`).

The one thing that *is* written twice is small and pinned by a test: the values on the
insert are `fullBucket(policy, now())` spelled out, because SQL cannot call the pure
module. A caller nobody has refused yet arrives with every attempt they have, and
`tests/rate-limit-policy.test.ts` asserts that `decide(fullBucket(…))` and
`decide(undefined, …)` are the same decision — so the insert and the decision cannot
drift into charging a first-time caller twice.

### 3. The clock is the database's

Both the decision and the row use `now()`, the transaction's own instant. With one row
read by several processes, the only clock all of them agree on is the row's: a process
whose clock ran fast would credit every bucket tokens nobody gave it, and "whose clock"
is not a question with an answer once the buckets are shared. `now()` is stable within
a transaction, which is what makes the value the decision used and the value written
back the same instant by construction rather than by arithmetic.

### 4. A key is bounded, because it is now a primary key

`MAX_BUCKET_KEY_LENGTH` (200) lives in the policy module beside `clientAddress`, and the
key is truncated to it. This is not tidiness: `login_failure` scopes its bucket by
whatever identifier was typed, and `loginSchema` puts no ceiling on that — so without a
cap, a caller posting a megabyte of identifier would fail the insert rather than be
counted by it, and the door would be unprotected in exactly the case it exists for.

Truncated rather than hashed, and the direction is deliberate: two absurd identifiers
sharing a prefix share a bucket, so the worst case is a caller limited slightly sooner
than their own attempts would have. The column is wider than the cap, so raising it is
a TypeScript change rather than a migration.

### 5. A store that cannot be reached lets the caller through

`chargeRateLimit` returns rather than throwing when the store is unreachable, and this
is the one place in the application where swallowing an error is the *safer* answer.
The alternative is a database that is merely slow turning a wrong password into a 500,
on doors whose refusals are already decided by the domain — and making the limiter
load-bearing is precisely what ADR 0009 decision 7 forbids. Failing open also fails
towards the shop's own revenue: every door it guards ends in a sale, a sign-in or a paid
order.

### 6. Pruning is a timer, not a size threshold

The `Map` version swept once it had ten thousand keys. A table needs the same
housekeeping and a simpler trigger: a `DELETE` runs at most once per process per
`FORGET_IDLE_AFTER_MS` — the same age it forgets at, because looking more often than
that cannot delete a row the previous look could not. It is best-effort, and it has to
be: a sweep that failed is a table that grows, which is a slow problem in a room full of
fast ones. The table therefore holds at most a couple of hours of buckets.

## Consequences

- A restart forgets nothing, and two processes enforce one limit between them. Both are
  asserted: `tests/rate-limit.test.ts` re-imports the module to simulate a restart, and
  reads the row directly to prove the spent attempt is not in the process.
- Every guarded door now costs one query. On the doors that charge before the work —
  setup, pairing, the webhook, enrolment — it is the first thing the request does; on
  login it runs only after a failed bcrypt compare, which is orders of magnitude slower
  than the query.
- One row per caller who has been limited lately. The table is not a log: nothing reads
  it but the limiter, and nothing about it is shown to a user.
- `rate_limit_buckets` is added to the tables the integration suite truncates, or a
  suite would inherit the previous run's spent bucket and be refused a request it was
  about to make.
- The trail's "one row per burst" got *stricter*: with a row lock, exactly one process
  sees the transition from not-refusing to refusing, where two processes could each have
  written their own first refusal.
- The migration adds one table and nothing else, and `docs/renter-onboarding.md`'s
  advice about lockouts is unchanged — nothing an operator does differently.

## Known gaps, stated rather than discovered

- **The limiter now depends on the database.** Decision 5 makes that fail open rather
  than closed, and every guarded door needed the database anyway — but a shop whose
  Postgres is down has no limiter, and this is the price of a shared one.
- **A hot key serialises.** Two requests racing on one bucket queue behind a row lock.
  At a shop's scale that is invisible, and ADR 0009 decision 1's answer to a
  *distributed* attacker is unchanged: that belongs in the reverse proxy.
- **Nothing caps the table from above.** A caller spraying from a large address space
  can add rows faster than the hourly sweep removes them. The rows are tiny and the
  sweep catches up; a deployment that cared would bound the table and refuse, which is
  a decision nobody has needed to make yet.
