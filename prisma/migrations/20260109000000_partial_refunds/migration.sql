-- ------------------------------------------------------------ partial refunds
--
-- Until now a credit note reversed a whole bill, and the schema said so: one note
-- per sale, enforced by a unique index, with the sale's own tax figures copied onto
-- it. A customer returning one item out of three is the everyday case, and it needs
-- two things this migration adds:
--
--   1. **A note has to itemise what it reverses.** `credit_note_items` records the
--      lines and quantities going back, which is what makes the document a credit
--      note rather than an adjustment, and what a later refund reads to know how
--      much of each line is still refundable.
--   2. **A sale may have several notes.** The unique index moves from `order_id` to
--      `(order_id, sequence)`, so the first note on a bill is still unique per sale
--      and the fourth is unremarkable.
--
-- What does *not* change, deliberately: the order's own totals. An invoice that has
-- been partly credited is still the invoice that was issued, and rewriting its
-- figures would destroy the document the credit note exists to point at. What was
-- refunded is the sum of the notes, which is a question the database can answer
-- rather than a column that can drift.

-- What the note's lines were charged, before the discount it accounts for. Stored
-- rather than summed from `credit_note_items` for the same reason the sale stores
-- its subtotal: it is the figure the document reconciles against, and a number that
-- has to be recomputed from children cannot be checked by the database.
ALTER TABLE "credit_notes"
    ADD COLUMN "gross_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- The share of the order-level discount this note accounts for. Without it the
-- document's lines and its total cannot be made to add up: a ฿300 sale with a ฿10
-- discount refunds ฿96.67 of a ฿100 line, and the ฿3.33 is not a rounding error to
-- be hidden but a figure the customer is entitled to see.
ALTER TABLE "credit_notes"
    ADD COLUMN "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 1-based, within one sale. Existing rows are all the first and only note on their
-- bill, which is exactly what the backfill below says.
ALTER TABLE "credit_notes"
    ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_gross_non_negative"
    CHECK ("gross_amount" >= 0);

ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_discount_non_negative"
    CHECK ("discount_amount" >= 0);

ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_sequence_positive"
    CHECK ("sequence" > 0);

-- The two reconstructions the document has to satisfy, both mirroring the sale's
-- own (`chk_orders_vat_reconstruction`): the lines less the discount are what is
-- handed back, and the base plus the tax is that same amount. Adding these two
-- columns is what makes a credit note checkable by the database rather than by a
-- code review of the transaction that wrote it.
ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_lines_reconcile"
    CHECK ("gross_amount" - "discount_amount" = "final_amount");

DROP INDEX "credit_notes_order_id_key";

CREATE UNIQUE INDEX "credit_notes_order_id_sequence_key"
    ON "credit_notes"("order_id", "sequence");

-- The notes already written were full reversals of their sales, so each one accounts
-- for that sale's whole discount. Backfilled rather than defaulted to zero, because
-- a zero here would make an already-issued document print a discount of nothing.
UPDATE "credit_notes" AS note
   SET "discount_amount" = "orders"."discount_amount",
       "gross_amount"    = note."final_amount" + "orders"."discount_amount"
  FROM "orders"
 WHERE "orders"."id" = note."order_id";

-- ------------------------------------------------------------- what it reverses

CREATE TABLE "credit_note_items" (
    "id"             BIGSERIAL      NOT NULL,
    "credit_note_id" UUID           NOT NULL,
    "order_item_id"  BIGINT         NOT NULL,
    "quantity"       INTEGER        NOT NULL,
    "unit_price"     DECIMAL(10,2)  NOT NULL,
    "line_total"     DECIMAL(10,2)  NOT NULL,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- One row per line per note: two rows for the same line on the same document would
-- be a document that cannot be added up without reading both.
CREATE UNIQUE INDEX "credit_note_items_note_order_item_key"
    ON "credit_note_items"("credit_note_id", "order_item_id");

CREATE INDEX "credit_note_items_order_item_id_idx"
    ON "credit_note_items"("order_item_id");

ALTER TABLE "credit_note_items"
    ADD CONSTRAINT "credit_note_items_credit_note_id_fkey"
        FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- RESTRICT: the line a credit note reverses is evidence, and deleting it would
    -- leave a document itemising something that no longer exists.
    ADD CONSTRAINT "credit_note_items_order_item_id_fkey"
        FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_note_items"
    ADD CONSTRAINT "chk_credit_note_items_quantity_positive"
    CHECK ("quantity" > 0);

-- The lines a note itemises are worth what it hands back, before the discount it
-- accounts for. Asserted per row and not in total, because a row is the unit that
-- has to be defensible on its own.
ALTER TABLE "credit_note_items"
    ADD CONSTRAINT "chk_credit_note_items_line_total"
    CHECK ("line_total" = ROUND("unit_price" * "quantity", 2));
