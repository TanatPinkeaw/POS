-- ------------------------------------------------- does this shop call numbers?
--
-- ADR 0017 gave every walk-in bill a short number and ADR 0018 gave the shop a
-- board to call it from, both stated as universal. Neither asked whether the shop
-- calls anybody: most of what this system sells is handed over on the spot, and
-- for those shops the feature is a line at the top of every slip that nobody
-- reads and a page in the till's navigation that nobody opens.
--
-- One column rather than a shop type, because a type would have to decide the
-- behaviour of features that have nothing to do with each other, and would do it
-- behind the shop's back -- the shop would be told "you sell goods", a customer
-- would ask for their number, and no one would have a switch to flip. The truth
-- stays a switch per job, set by the shop, in its own words.
--
-- DEFAULT true, which is the value every row has in the only sense it has had:
-- the feature has always been on. Any other default would silently take the call
-- numbers away from a shop that was relying on them, on the day it upgraded.
--
-- NOT NULL on purpose. There is no third state to reason about -- a shop either
-- calls its customers by number or it does not -- and a nullable column would put
-- that question into every query that reads it.
--
-- No backfill is needed and none is possible: the column did not exist before this
-- statement, so DEFAULT true is what fills the one row there is.

ALTER TABLE "shops"
  ADD COLUMN "calls_numbers" BOOLEAN NOT NULL DEFAULT true;
