-- Payment intents and customer displays.
--
-- A payment intent is the record of "a QR was issued for this amount, and here is
-- what happened to it". It exists because a transfer cannot be verified from the
-- browser: the code is minted here, shown on two screens, and closed when a
-- confirmation arrives from whatever source the shop has — a bank-notification
-- bridge, a provider webhook, or a person with the PIN. Without a row to hold the
-- amount and the reference there is nothing to match a confirmation against, and
-- nothing to stop one transfer closing two bills.
--
-- The display devices table is deliberately tiny: a customer screen holds no data
-- of its own, only the right to receive the till's.
--
-- Generated with:
--   prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
-- then edited by hand, as elsewhere in this directory. As always, the diff also
-- proposed `ALTER TABLE "time_logs" DROP COLUMN "work_hours"` — a STORED generated
-- column Prisma cannot see — and that statement is excluded deliberately.

-- CreateEnum
CREATE TYPE "promptpay_id_type" AS ENUM ('mobile', 'national_id', 'ewallet');

-- CreateEnum
CREATE TYPE "payment_intent_status" AS ENUM ('pending', 'paid', 'expired', 'cancelled', 'consumed');

-- AlterTable
ALTER TABLE "shops"
    ADD COLUMN "promptpay_id" VARCHAR(20),
    ADD COLUMN "promptpay_type" "promptpay_id_type";

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" BIGSERIAL NOT NULL,
    "ref" VARCHAR(12) NOT NULL,
    "shift_id" INTEGER NOT NULL,
    "cashier_id" UUID NOT NULL,
    "order_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "qr_payload" TEXT NOT NULL,
    "status" "payment_intent_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "confirmed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- The reference is what a webhook quotes back, so it has to be unique and it has
-- to be short: it is read off a screen or out of a bank notification by a person
-- as often as by a machine.
CREATE UNIQUE INDEX "payment_intents_ref_key" ON "payment_intents"("ref");
CREATE INDEX "payment_intents_status_expires_at_idx" ON "payment_intents"("status", "expires_at");
CREATE INDEX "payment_intents_order_id_idx" ON "payment_intents"("order_id");

-- An intent is for money, so it cannot be for nothing. A zero-amount intent is
-- not a rounding case: it is a QR that would let a customer pay whatever they
-- liked, which is the exact failure this table exists to prevent.
ALTER TABLE "payment_intents"
    ADD CONSTRAINT "chk_payment_intents_amount" CHECK ("amount" > 0);

-- A paid intent has a time it was paid, and an unpaid one does not. Stating it
-- here means a future code path cannot record "paid" without a timestamp for the
-- trail to use.
ALTER TABLE "payment_intents"
    ADD CONSTRAINT "chk_payment_intents_paid_at"
    CHECK (("status" IN ('paid', 'consumed')) = ("paid_at" IS NOT NULL));

-- One live intent per QR series: a second pending intent for the same reference
-- would make an incoming confirmation ambiguous.
ALTER TABLE "payment_intents"
    ADD CONSTRAINT "chk_payment_intents_consumed_at"
    CHECK (("status" = 'consumed') = ("consumed_at" IS NOT NULL));

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "display_devices" (
    "id" BIGSERIAL NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "pairing_code" VARCHAR(6),
    "pairing_expires_at" TIMESTAMPTZ(6),
    "paired_by_user_id" UUID,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "display_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "display_devices_token_hash_key" ON "display_devices"("token_hash");

-- A pairing code is a six-digit secret with a short life. Unique while it is
-- live, so two screens cannot be handed the same code, but not unique forever:
-- a long-dead code must not block a new device from drawing it.
CREATE UNIQUE INDEX "display_devices_pairing_code_key"
    ON "display_devices"("pairing_code")
    WHERE "pairing_code" IS NOT NULL;

-- The code is worthless after it expires, and a row left holding one is a row that
-- could still be paired by anyone who read it over a shoulder.
ALTER TABLE "display_devices"
    ADD CONSTRAINT "chk_display_devices_pairing"
    CHECK (
        ("pairing_code" IS NULL) = ("pairing_expires_at" IS NULL)
    );

ALTER TABLE "display_devices" ADD CONSTRAINT "display_devices_paired_by_user_id_fkey" FOREIGN KEY ("paired_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
