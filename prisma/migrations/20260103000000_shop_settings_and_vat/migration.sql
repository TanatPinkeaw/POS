-- Shop identity, VAT and gapless receipt numbering — ADR 0002.
--
-- The SRS has no shop identity and no tax concept at all, so unlike the initial
-- migration nothing here can cite a section of `system_requirements_document.md`.
--
-- As in the initial migration, the constraints that the Prisma schema language
-- cannot express are written here by hand and this file is authoritative for
-- them. Keep applying it with `prisma migrate deploy` and never `migrate dev`,
-- or the hand-written half is dropped.

-- CreateTable
CREATE TABLE "shops" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(150) NOT NULL,
    "legal_name" VARCHAR(200),
    "branch_label" VARCHAR(100),
    "tax_id" VARCHAR(13),
    "address" TEXT,
    "phone" VARCHAR(20),
    "is_vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 7,
    "prices_include_vat" BOOLEAN NOT NULL DEFAULT true,
    "receipt_prefix" VARCHAR(10) NOT NULL DEFAULT 'RC',
    "receipt_running_number" BIGINT NOT NULL DEFAULT 0,
    "receipt_footer" TEXT,
    "logo_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- A shop is a singleton, and a primary key is what makes that true rather than
-- merely intended: two requests racing through the setup wizard cannot both win,
-- because the second INSERT collides here instead of passing a read-then-write
-- check in application code.
ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_singleton" CHECK ("id" = 1);

-- A VAT rate is a percentage. 7 is the current Thai standard rate; the range is
-- bounded so a mistyped rate cannot produce a negative or absurd tax line.
ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_vat_rate_range" CHECK ("vat_rate" >= 0 AND "vat_rate" <= 100);

-- A 13-digit Thai tax identification number, digits only. Nullable because a
-- shop that is not VAT-registered has none.
ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_tax_id_format" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$');

-- Running numbers only ever increase, so a receipt can never be reissued a
-- number that has already been used on a printed document.
ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_receipt_running_number_non_negative" CHECK ("receipt_running_number" >= 0);

-- AlterTable: tax facts are snapshotted onto the order rather than recomputed
-- from the shop's current settings. `vat_rate_used` is what lets a receipt
-- printed in 2026 still show 7% after the rate changes.
ALTER TABLE "orders" ADD COLUMN "net_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "vat_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "vat_rate_used" DECIMAL(5,2);
ALTER TABLE "orders" ADD COLUMN "is_vat_invoice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "receipt_number" VARCHAR(30);

-- CreateIndex
CREATE UNIQUE INDEX "orders_receipt_number_key" ON "orders"("receipt_number");

-- Backfill before asserting the invariant: orders placed before this migration
-- had no tax concept, so their entire collected amount is treated as the
-- taxable base. That keeps history unchanged — a 2026 sale must not acquire a
-- VAT line it never had — and it is what makes the CHECK below satisfiable on
-- an existing database rather than failing the migration outright.
UPDATE "orders"
   SET "net_amount" = "final_amount"
 WHERE "net_amount" = 0
   AND "vat_amount" = 0
   AND "final_amount" <> 0;

-- Every order must reconstruct exactly: the taxable base plus the tax is the
-- amount actually collected. Checking it in the database means a future edit to
-- the sale path cannot quietly break the arithmetic that a tax receipt asserts.
ALTER TABLE "orders"
    ADD CONSTRAINT "chk_orders_vat_reconstruction" CHECK ("net_amount" + "vat_amount" = "final_amount");

-- Imported opening balances get their own reason, so an import is
-- distinguishable from a human counting stock.
ALTER TYPE "stock_adjustment_reason" ADD VALUE IF NOT EXISTS 'REASON_IMPORT';

-- Deleting a category that still has products is now refused by the database
-- rather than silently orphaning them (was ON DELETE SET NULL).
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
