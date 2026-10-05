-- ------------------------------------------------- the pre-order's own deadline
--
-- SRS §3 Phase 1 says an unconfirmed pre-order expires after a while. Which way
-- this repository had that "after a while" written is the whole reason this
-- column exists.
--
-- It was `created_at + PREORDER_CONFIRM_TIMEOUT_MINUTES`, evaluated at read
-- time — in the expiry sweeper *and* separately, a hardcoded copy, on the
-- pre-order board. Two evaluations of one rule, and they drift the moment either
-- side of it moves:
--
--   * Raise the shop's timeout from 15 to 30 minutes and every order already
--     sitting in the queue gets 15 extra minutes that were never promised to it,
--     while an order placed *after* the change expires on the new clock. The
--     same queue then holds two orders with different deadlines on the same
--     board.
--   * Lower it, and orders placed under the old rule are cancelled out from under
--     a customer who was told thirty minutes.
--
-- Storing the deadline once, at the moment the order is placed, makes that
-- impossible: the board counts down to a real value and the sweeper expires on
-- that same value, and changing the shop's setting afterwards only affects
-- orders placed afterwards — which is what "changing your mind about the future"
-- should mean.
--
-- Nullable, and deliberately so, for two reasons. A walk-in sale has no Phase 1
-- and never gets one, so NULL is the ordinary state for most of this table
-- rather than a gap. And for the rows that predate this migration the value is
-- unknown rather than wrong, so the backfill below fills what can be filled and
-- leaves the rest for the sweeper's fallback to reason about.
--
-- The backfill runs on the old 15-minute default because that is the only value
-- those rows were ever subject to — re-deriving them under the new default would
-- retroactively lengthen the deadline of an order a customer may already have
-- seen expire.
--
-- No index is added for it. The sweeper's query is `status = 'pending' AND
-- order_type = 'preorder' AND confirm_deadline < now`, and the existing
-- `(order_type, status)` index already narrows it to the handful of unconfirmed
-- orders on the shelf. A partial index would be marginally better and would also
-- be invisible to Prisma, which cannot model one — so the next `migrate dev`
-- would find a database object the schema does not describe and offer to drop
-- it. A column Prisma knows about, queried through an index it already knows
-- about, is worth more than the rows it would save.

ALTER TABLE "orders"
  ADD COLUMN "confirm_deadline" TIMESTAMPTZ(6);

UPDATE "orders"
   SET "confirm_deadline" = "created_at" + INTERVAL '15 minutes'
 WHERE "status" = 'pending'
   AND "order_type" = 'preorder'
   AND "confirm_deadline" IS NULL;