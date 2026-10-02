-- ------------------------------------------------- consigned goods (ADR 0023)
--
-- The first feature where the shop sells goods it does not own, and the whole
-- design is to add *only* what consignment needs rather than a second inventory and
-- a second sales path. Ownership rides on `products` (so `stock_qty`, the oversell
-- guard, the safety quantity, the offline snapshot and every report keep working
-- untouched), and the money the shop owes is an append-only ledger beside
-- `point_transactions`.
--
--   * `products.consignor_user_id` / `consignor_share_percent` — a product is either
--     the shop's or exactly one member's. The CHECKs below are the same instinct as
--     `chk_number_blocks_range`: the states that must not exist are refused by the
--     database rather than by every future code path remembering to refuse them.
--       - the two columns move together (a share with no consignor, or a consignor
--         with no share, is a liability with no terms or terms with no owner);
--       - the share is a whole percentage from 0 to 100.
--
--   * `consignor_payables` — one row per movement, signed, summed for a balance.
--     A sale credits the consignor their share (ADR 0023 §4, §5); a refund of that
--     sale debits it back (ADR 0023 §6); a payout debits it as the shop hands the
--     money over. The CHECK on `kind` and the sign of `amount_thb` is what stops a
--     credit that should be a debit from being written at all — the failure mode a
--     ledger otherwise only reveals when somebody adds it up.

CREATE TYPE "consignor_payable_kind" AS ENUM ('sale', 'refund', 'payout');

ALTER TABLE "products"
  ADD COLUMN "consignor_user_id" UUID,
  ADD COLUMN "consignor_share_percent" INTEGER;

ALTER TABLE "products"
  ADD CONSTRAINT "chk_products_consignor_pair"
    CHECK (("consignor_user_id" IS NULL) = ("consignor_share_percent" IS NULL)),
  ADD CONSTRAINT "chk_products_consignor_share"
    CHECK ("consignor_share_percent" IS NULL OR "consignor_share_percent" BETWEEN 0 AND 100);

-- Restrict, not SetNull: deleting the member who consigned goods would orphan the
-- shop's liability to them, and the database refuses it rather than losing the debt.
ALTER TABLE "products"
  ADD CONSTRAINT "products_consignor_user_id_fkey"
  FOREIGN KEY ("consignor_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "products_consignor_user_id_idx" ON "products"("consignor_user_id");

CREATE TABLE "consignor_payables" (
  "id"                BIGSERIAL      NOT NULL,
  "consignor_user_id" UUID           NOT NULL,
  "kind"              "consignor_payable_kind" NOT NULL,
  -- Signed to the satang: a sale credits, a refund and a payout debit.
  "amount_thb"        NUMERIC(10, 2) NOT NULL,
  "order_id"          UUID,
  "order_item_id"     BIGINT,
  "product_id"        UUID,
  "description"       VARCHAR(255),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "consignor_payables_pkey" PRIMARY KEY ("id"),
  -- A credit cannot be negative and a debit cannot be positive, by kind.
  CONSTRAINT "chk_consignor_payables_sign" CHECK (
    ("kind" = 'sale'   AND "amount_thb" >= 0)
    OR ("kind" <> 'sale' AND "amount_thb" <= 0)
  )
);

ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "consignor_payables_consignor_user_id_fkey"
  FOREIGN KEY ("consignor_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull, not Cascade: the ledger row is the record of the debt, and it must outlive
-- the order it names — an order is never hard-deleted in this system, but the same
-- reasoning as `point_transactions.order_id` keeps the ledger honest if one ever were.
ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "consignor_payables_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "consignor_payables_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "consignor_payables_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "consignor_payables_consignor_user_id_created_at_idx"
  ON "consignor_payables"("consignor_user_id", "created_at");
CREATE INDEX "consignor_payables_order_id_idx" ON "consignor_payables"("order_id");
