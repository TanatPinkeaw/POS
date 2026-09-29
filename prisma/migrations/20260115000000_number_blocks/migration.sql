-- ------------------------------------------------------ offline number blocks
--
-- The shop's numbers are allocated by the server, inside the sale's transaction, and
-- that is what makes the receipt series gapless (ADR 0002). A device that may lose its
-- connection cannot do that — but a shop whose internet dropped must still be able to
-- hand a customer a numbered tax invoice. So the shop *lends* a range in advance and
-- the device issues from it (ADR 0019).
--
-- This table is the loan. It exists as rows rather than as columns on `shops` for three
-- reasons that all come from the same place — a loan is an event, not a setting:
--
--   * **A series can be frozen.** While a device holds an unreported block, nothing
--     else may allocate from that series, because the only way the device's numbers and
--     the server's numbers can stay in one increasing order is for the server to wait.
--     "Is this series frozen" is therefore `EXISTS` over these rows, asked in the same
--     statement that allocates, rather than a flag somebody has to remember to clear.
--   * **The unused tail has to come back.** `last_used_number` — not `to_number` — is
--     what the counter is set to when a block is reported. A device that borrowed 50
--     numbers and printed 12 gives 38 of them back, and the series has no hole in it.
--   * **A device that never comes back is a task, not a silence.** An open row is
--     visible, and an admin resolves it by naming the last number actually printed or
--     cancelling the loan.
--
-- The CHECK constraints below are the same instinct as `chk_payments_amount_positive`:
-- the states that must not exist are refused by the database rather than by every future
-- code path remembering them.
--
--   * a block whose end precedes its start (which would read as "exhausted" forever);
--   * a `last_used_number` outside its own range, or one that equals nothing at all;
--   * both closed and cancelled, or neither — a closed block reports, a cancelled block
--     gives everything back, and there is no third thing;
--   * a cancelled block that was in fact used: that is a *report*, and allowing it here
--     would let a caller cancel numbers it had already printed on paper;
--   * a call-number block with no day — the day is what a device compares its own clock
--     against, and it is what the per-day unique index below is built on.
CREATE TYPE "number_series" AS ENUM ('receipt', 'queue');

CREATE TABLE "number_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "series" "number_series" NOT NULL,
    "day" DATE,
    "from_number" INTEGER NOT NULL,
    "to_number" INTEGER NOT NULL,
    "last_used_number" INTEGER,
    "device_label" VARCHAR(60) NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    -- Who closed it: the device reporting itself, or the admin resolving a loose end. Two
    -- different acts with the same shape, and the second is the one a later reader needs
    -- a name for.
    "closed_by" UUID,

    CONSTRAINT "number_blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_number_blocks_range" CHECK ("to_number" >= "from_number"),
    CONSTRAINT "chk_number_blocks_last_used" CHECK (
      "last_used_number" IS NULL
      OR ("last_used_number" >= "from_number" AND "last_used_number" <= "to_number")
    ),
    CONSTRAINT "chk_number_blocks_closed_once" CHECK ("reported_at" IS NULL OR "cancelled_at" IS NULL),
    CONSTRAINT "chk_number_blocks_cancel_unused" CHECK ("cancelled_at" IS NULL OR "last_used_number" IS NULL),
    CONSTRAINT "chk_number_blocks_day_series" CHECK (("series" = 'queue') = ("day" IS NOT NULL))
);

CREATE INDEX "number_blocks_series_opened_at_idx" ON "number_blocks"("series", "opened_at");

ALTER TABLE "number_blocks"
  ADD CONSTRAINT "number_blocks_opened_by_fkey"
  FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "number_blocks"
  ADD CONSTRAINT "number_blocks_closed_by_fkey"
  FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one *open* block per series (per day for the queue series), which is what
-- makes a second borrow a refusal rather than a second loan. Two devices holding the
-- same day's call numbers would be two customers hearing the same number — the failure
-- `orders_queue_day_queue_number_key` exists to prevent, arriving through a door that
-- index cannot see.
--
-- Partial unique indexes rather than Prisma's `@@unique`: the rule is about *open* rows,
-- and Prisma cannot express a predicate. They are also the index the freeze query uses,
-- so the check that refuses an allocation costs nothing extra to ask.
--
-- Deliberately not enforced: that a new block starts where the counter is. That is the
-- allocation's own job (a single `UPDATE … RETURNING`), and it is the one awkward thing
-- to state in SQL — the counter and the range have to move together or neither should.
CREATE UNIQUE INDEX "number_blocks_open_receipt_key"
  ON "number_blocks"("series")
  WHERE "series" = 'receipt' AND "reported_at" IS NULL AND "cancelled_at" IS NULL;

CREATE UNIQUE INDEX "number_blocks_open_queue_day_key"
  ON "number_blocks"("day")
  WHERE "series" = 'queue' AND "reported_at" IS NULL AND "cancelled_at" IS NULL;
