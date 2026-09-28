-- ------------------------------------------------------- credit notes & refunds
--
-- A paid sale becomes reversible, with a document behind the reversal.
--
-- Hand-written on purpose. `prisma migrate dev` diffs the database against
-- `prisma/schema.prisma` and would therefore propose dropping
-- `time_logs.work_hours` (a STORED generated column Prisma cannot model, added by
-- the initial migration and absent from the schema — see ADR 0001 §6). This
-- database is maintained with `prisma migrate deploy`, and a migration that
-- changes the schema by hand is the price of that fact.
--
-- Four decisions are expressed here rather than in application code:
--
--   1. **A refunded sale is its own status.** `completed → refunded` is the only
--      way in and `refunded` is terminal, so `canTransition` refuses a second
--      refund before a transaction is opened.
--   2. **Money direction is a column, not a sign.** `chk_payments_amount_positive`
--      stays exactly as it was: `amount` is a magnitude, `direction` says which
--      way it went, and the two together cannot be read wrongly by accident.
--   3. **A refund leg must name its document.** A CHECK ties `credit_note_id` to
--      `direction`, so money cannot leave the till without a credit note behind
--      it, and a sale cannot claim one.
--   4. **One credit note per order, enforced by a unique index** rather than only
--      by the status check a second concurrent request could race past.

-- (1) The new status. Appended, so the existing values keep their order.
--
-- PostgreSQL 12+ allows ADD VALUE inside a transaction, which is what Prisma
-- wraps a migration in — but the value cannot be *used* until the transaction
-- commits, so nothing below this line may reference 'refunded'.
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'refunded';

-- (2) Which way the money went.
CREATE TYPE "payment_direction" AS ENUM ('sale', 'refund');

-- Goods coming back onto the shelf, distinct from a supplier delivery.
ALTER TYPE "stock_movement_type" ADD VALUE IF NOT EXISTS 'pos_refund';

-- Money going back to a customer is a gated action, and the vocabulary of the
-- trail is closed, so it costs a migration. That is the point of the enum.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'refund_order';

-- ------------------------------------------------------- the credit-note series
--
-- A second gapless series, beside the receipt series and with the same rule:
-- bumped by an UPDATE inside the caller's transaction, so a refund that rolls
-- back does not burn a number and the series has no holes in it.

ALTER TABLE "shops"
    ADD COLUMN "credit_note_prefix"         VARCHAR(10) NOT NULL DEFAULT 'CN',
    ADD COLUMN "credit_note_running_number" BIGINT      NOT NULL DEFAULT 0;

ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_credit_note_running_number_non_negative"
    CHECK ("credit_note_running_number" >= 0);

-- ------------------------------------------------------------ the credit note

CREATE TABLE "credit_notes" (
    "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
    "document_number"       VARCHAR(30)   NOT NULL,
    "order_id"              UUID          NOT NULL,
    "shift_id"              INTEGER,
    "reason"                TEXT          NOT NULL,
    "refund_method"         "payment_method" NOT NULL,
    "final_amount"          DECIMAL(10,2) NOT NULL,
    "net_amount"            DECIMAL(10,2) NOT NULL,
    "vat_amount"            DECIMAL(10,2) NOT NULL,
    "vat_rate_used"         DECIMAL(5,2),
    "points_clawed_back"    INTEGER       NOT NULL DEFAULT 0,
    "points_forgiven"       INTEGER       NOT NULL DEFAULT 0,
    "created_by"            UUID          NOT NULL,
    "authorized_by_user_id" UUID,
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_notes_document_number_key" ON "credit_notes"("document_number");

-- One credit note per sale, and this is the half of the guard that survives a
-- race: the status transition stops the API path, this stops everything else.
CREATE UNIQUE INDEX "credit_notes_order_id_key" ON "credit_notes"("order_id");

CREATE INDEX "credit_notes_shift_id_idx"   ON "credit_notes"("shift_id");
CREATE INDEX "credit_notes_created_at_idx" ON "credit_notes"("created_at");

ALTER TABLE "credit_notes"
    ADD CONSTRAINT "credit_notes_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "credit_notes_shift_id_fkey"
        FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "credit_notes_created_by_fkey"
        FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "credit_notes_authorized_by_user_id_fkey"
        FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The document's own lines must add up, exactly as the sale's did. Mirrors
-- `chk_orders_vat_reconstruction` rather than trusting a code review.
ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_vat_reconstruction"
    CHECK ("net_amount" + "vat_amount" = "final_amount");

-- A credit note records money going out, so it is never zero and never negative.
-- This is what makes "a refund of nothing" a refused document rather than a
-- printable one.
ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_final_amount_positive"
    CHECK ("final_amount" > 0);

ALTER TABLE "credit_notes"
    ADD CONSTRAINT "chk_credit_notes_points_non_negative"
    CHECK ("points_clawed_back" >= 0 AND "points_forgiven" >= 0);

-- ------------------------------------------------------- the money legs of it

ALTER TABLE "payments"
    ADD COLUMN "direction"      "payment_direction" NOT NULL DEFAULT 'sale',
    ADD COLUMN "credit_note_id" UUID;

CREATE INDEX "payments_direction_idx"      ON "payments"("direction");
CREATE INDEX "payments_credit_note_id_idx" ON "payments"("credit_note_id");

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_credit_note_id_fkey"
        FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: deleting the document that justified a payout would
-- leave cash in the drawer with nothing explaining it, which is the one thing a
-- cash trail must never do.

-- A refund leg names a credit note; a sale leg does not. Written as an equality
-- between two booleans so it reads as the statement it is — "this is a refund if
-- and only if it has a document" — and so a future third direction has to
-- confront the rule rather than slip through it.
ALTER TABLE "payments"
    ADD CONSTRAINT "chk_payments_credit_note_by_direction"
    CHECK (("direction" = 'refund') = ("credit_note_id" IS NOT NULL));

-- `chk_payments_amount_positive` is deliberately untouched. `amount` stays a
-- magnitude greater than zero; the sign lives in `direction`, which is what lets
-- every existing sum keep its existing meaning and forces each new one to say
-- what it is doing.
