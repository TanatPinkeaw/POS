-- ------------------------------------------------------------ call numbers
--
-- A customer waiting for a drink is called by a number, and until now the only
-- number this system had was the receipt's. That one cannot do the job: it is a
-- tax document's name (`FR-2026-000123`), it grows all year, it does not exist at
-- all for a shop that is not VAT-registered, and nobody shouts it across a
-- counter. So a bill gets a second, short number — 1, 2, 3 … within one *day*.
-- ADR 0017 is the decision, including why the two series are kept apart instead of
-- bending the receipt series into a call number.
--
-- `queue_running_day` is what resets it. Retail already expects this — every
-- coffee shop's ticket starts at 1 in the morning — and without a stored day the
-- alternative is numbering forever upward, where the number a customer hears is a
-- measure of how long the shop has been open instead of how long they have waited.
--
-- The column pairs are on the shop row and on the order respectively, mirroring the
-- receipt series exactly (`receipt_running_number` / `receipt_number`) rather than
-- inventing a second mechanism: a counter that must not have holes in it is bumped
-- by an `UPDATE … RETURNING` inside the sale's own transaction, so a sale that
-- rolls back restores the counter with everything else. A `SEQUENCE` would not —
-- `nextval` is non-transactional, so a refused sale would burn a number and two
-- customers the same day would hear the same one.
--
-- `queue_day` on the order is a stored DATE rather than something derived from
-- `created_at`, and that is not redundancy: it is what the unique index below can
-- be built on, and it is what pins the number to the Bangkok day it was called on.
-- `created_at` is an instant in UTC; between local midnight and 07:00 the two
-- disagree, and that is exactly when a shop is open.
ALTER TABLE "shops"
  ADD COLUMN "queue_running_number" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queue_running_day" DATE;

ALTER TABLE "orders"
  ADD COLUMN "queue_number" INTEGER,
  ADD COLUMN "queue_day" DATE;

-- One bill per number per day, enforced by the database rather than by the
-- allocation being careful. Two bills sharing a number is one customer called to
-- another customer's order, which reads as a mistake by the staff rather than as
-- the bug it is. NULLs are distinct in PostgreSQL, so the pre-orders that carry no
-- call number — their handover already has a bill number and a PIN — do not
-- collide here.
CREATE UNIQUE INDEX "orders_queue_day_queue_number_key" ON "orders"("queue_day", "queue_number");
