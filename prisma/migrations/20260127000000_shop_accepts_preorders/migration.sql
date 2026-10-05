-- ------------------------------------------------- does this shop take pre-orders?
--
-- The same shape as ADR 0027's switch, and it exists because the shop asked. A shop
-- that sells over the counter has no reason to let a customer order now and collect
-- tomorrow: the member-facing page keeps offering it, the board keeps waiting, and
-- the till keeps reserving stock for goods the shop never intended to hold.
--
-- One column, NOT NULL, DEFAULT true, for the same reasons as `calls_numbers` and
-- with the same trade: the only value any row has ever had is true, so that is what
-- this fills, and a migration is not the moment to take a shop's pre-orders away
-- quietly. There is no third state to represent -- a shop either takes them or it
-- does not.
--
-- No backfill is needed and none is possible: the column did not exist before this
-- statement.
--
-- Nothing here touches existing orders. Their life cycle -- pending, confirmed,
-- ready, collected -- belongs to the order, not to this setting, and a shop that
-- closes the door still finishes what it already opened.

ALTER TABLE "shops"
  ADD COLUMN "accepts_preorders" BOOLEAN NOT NULL DEFAULT true;
