-- ------------------------------------------------------- rate limiter buckets
--
-- The limiter's memory used to be a `Map` in the process, and ADR 0009 decision 1
-- said so on purpose: one Node listener for one shop, so a shared store would mean
-- Redis or a table for a limit that only has to survive a burst. Both halves of that
-- trade stopped holding. A deployment with two processes behind a load balancer has
-- two independent limiters, each half as strict as the configuration says — and "a
-- restart forgets every bucket" is not a footnote when it means a limiter whose
-- strictness depends on how often the shop restarts. So the buckets move here, one
-- row per bucket, and ADR 0012 is the decision.
--
-- One row per bucket, keyed by the same string the policy layer composes
-- (`policy|address`, or `policy|address|scope`), so the row that exists for a caller
-- is the row the pure decision already reasons about. `tokens` is DOUBLE PRECISION
-- rather than integer because refill is continuous: a bucket genuinely holds 3.4
-- attempts, and rounding that to 3 would make the limiter stricter than its own
-- arithmetic — which is unit-tested, and which this table must not contradict.
--
-- `updated_at` is written by the application with `now()`, the transaction's own
-- clock, and read back the same way. With one row read by several processes the only
-- clock all of them agree on is the database's: a process whose clock ran fast would
-- otherwise credit every bucket tokens nobody gave it.
--
-- No index beyond the primary key. The table is one row per caller who has been
-- limited lately — a shop's whole address space is a handful of rows — and the sweep
-- that keeps it that way is a `DELETE ... WHERE updated_at <`, which a table this
-- size scans faster than it would maintain an index. The VARCHAR(255) is wider than
-- `MAX_BUCKET_KEY_LENGTH` (200) on purpose, so that cap can be raised in TypeScript
-- without a migration to match.
CREATE TABLE "rate_limit_buckets" (
    "bucket_key" VARCHAR(255) NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "refusing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("bucket_key")
);
