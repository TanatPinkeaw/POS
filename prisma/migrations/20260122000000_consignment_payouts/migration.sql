-- ------------------------------------------------- payouts and their statements
--
-- The ledger says what the shop owes a consignor; this table records settling it.
-- A document rather than a flag on the ledger, because money leaving the shop to
-- somebody outside it needs to name the day, the method, the drawer (for cash) and
-- the person who handed it over — the shape `credit_notes` already gives a refund.
--
--   * `consignor_payouts` — one row per settlement, the statement itself.
--   * `consignor_payables.payout_id` — the ledger's debit points back here, so the
--     arithmetic and the paper behind it can never be separated.
--
-- `method` reuses `payment_method` the way a refund does, and the CHECK stated here
-- is the same rule a refund follows: cash comes out of a drawer and carries its
-- shift; a transfer touches no drawer and carries none.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_paid';

CREATE TABLE "consignor_payouts" (
  "id"                BIGSERIAL      NOT NULL,
  "consignor_user_id" UUID           NOT NULL,
  "method"            "payment_method" NOT NULL,
  -- Always positive: the direction is the method and the ledger row, never a sign here.
  "amount_thb"        NUMERIC(12, 2) NOT NULL,
  -- Null for a transfer, which never touched a drawer, and required for cash.
  "shift_id"          INTEGER,
  "note"              VARCHAR(255),
  "created_by"        UUID           NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "consignor_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_consignor_payouts_positive" CHECK ("amount_thb" > 0),
  -- A cash payout has a drawer and a transfer has none, by kind.
  CONSTRAINT "chk_consignor_payouts_shift" CHECK (
    ("method" = 'cash' AND "shift_id" IS NOT NULL)
    OR ("method" <> 'cash' AND "shift_id" IS NULL)
  )
);

ALTER TABLE "consignor_payouts"
  ADD CONSTRAINT "consignor_payouts_consignor_user_id_fkey"
  FOREIGN KEY ("consignor_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consignor_payouts"
  ADD CONSTRAINT "consignor_payouts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consignor_payouts"
  ADD CONSTRAINT "consignor_payouts_shift_id_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "consignor_payouts_consignor_user_id_created_at_idx"
  ON "consignor_payouts"("consignor_user_id", "created_at");

CREATE INDEX "consignor_payouts_shift_id_idx" ON "consignor_payouts"("shift_id");

-- The ledger's payout debit points at the statement; every other kind points at
-- nothing. Stated as a CHECK so money can never leave the ledger without paper.
ALTER TABLE "consignor_payables" ADD COLUMN "payout_id" BIGINT;

ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "chk_consignor_payables_payout" CHECK (
    ("kind" = 'payout') = ("payout_id" IS NOT NULL)
  );

ALTER TABLE "consignor_payables"
  ADD CONSTRAINT "consignor_payables_payout_id_fkey"
  FOREIGN KEY ("payout_id") REFERENCES "consignor_payouts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "consignor_payables_payout_id_idx" ON "consignor_payables"("payout_id");
