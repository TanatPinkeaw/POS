-- ------------------------------------------------------- offline safety reserve
--
-- The offline sell promise is weaker than the online one, and this column is how a
-- shop chooses how much weaker. Online, "never oversell" is a single conditional
-- `UPDATE` against the live row (`src/lib/inventory.ts`), so 50 racing tills and 20
-- units leave 20 sales and 30 refusals. Offline there is no live row to condition on:
-- the device holds a snapshot of the shelf and a tally of what it has already
-- promised, and nothing on the server can see either. So the promise becomes "no
-- oversell beyond the reserve the shop set", and the reserve is per product.
--
-- Zero — the default — is deliberate rather than lazy. A reserve nobody asked for
-- would be an item a shop cannot sell for a reason it never chose, and the first shop
-- meets this feature with a catalogue of hundreds of rows it will not edit by hand.
-- What protects the shop by default is the *tally*: the device counts what its own
-- unsent bills have promised, so one tablet cannot sell the same unit twice. This
-- column is for the case the tally cannot answer — the last two of something a
-- pre-order is on its way to collect.
--
-- The CHECK is the same instinct as `chk_payments_amount_positive`: a negative reserve
-- would make `available − safety` *larger* than the shelf, which reads as a licence to
-- oversell. That must not be reachable by any code path, so the database refuses it
-- rather than every writer remembering to.
ALTER TABLE "products" ADD COLUMN "offline_safety_qty" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "products"
  ADD CONSTRAINT "chk_products_offline_safety_non_negative" CHECK ("offline_safety_qty" >= 0);
