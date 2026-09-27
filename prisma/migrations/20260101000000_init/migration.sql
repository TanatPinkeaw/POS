-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('member', 'employee', 'admin');

-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('pos_walkin', 'preorder');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('cash', 'promptpay', 'points', 'mixed');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('manual_adjust', 'pos_sale', 'preorder_reserve', 'preorder_cancel', 'restock');

-- CreateEnum
CREATE TYPE "stock_adjustment_reason" AS ENUM ('REASON_RESTOCK', 'REASON_DAMAGED', 'REASON_EXPIRED', 'REASON_CORRECTION');

-- CreateEnum
CREATE TYPE "shift_status" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255),
    "phone" VARCHAR(20) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'member',
    "points_balance" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" INTEGER,
    "barcode" VARCHAR(64),
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "cost_price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sale_price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_logs" (
    "id" BIGSERIAL NOT NULL,
    "product_id" UUID NOT NULL,
    "changed_by" UUID NOT NULL,
    "movement_type" "stock_movement_type" NOT NULL,
    "reason" "stock_adjustment_reason",
    "qty_changed" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" SERIAL NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_date" DATE NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "end_time" TIME(6) NOT NULL,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_logs" (
    "id" SERIAL NOT NULL,
    "employee_id" UUID NOT NULL,
    "check_in" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "check_out" TIMESTAMPTZ(6),
    "note" TEXT,

    CONSTRAINT "time_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_shifts" (
    "id" SERIAL NOT NULL,
    "opened_by" UUID NOT NULL,
    "closed_by" UUID,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "initial_cash" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "expected_cash" DECIMAL(10,2),
    "actual_cash" DECIMAL(10,2),
    "status" "shift_status" NOT NULL DEFAULT 'open',

    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" VARCHAR(30) NOT NULL,
    "order_type" "order_type" NOT NULL DEFAULT 'pos_walkin',
    "status" "order_status" NOT NULL DEFAULT 'pending',
    "customer_id" UUID,
    "cashier_id" UUID,
    "pickup_pin" VARCHAR(6),
    "pickup_expires_at" TIMESTAMPTZ(6),
    "subtotal_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "final_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "points_earned" INTEGER NOT NULL DEFAULT 0,
    "points_redeemed" INTEGER NOT NULL DEFAULT 0,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "unit_cost" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "total_price" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "shift_id" INTEGER,
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "received_amount" DECIMAL(10,2),
    "change_amount" DECIMAL(10,2),
    "transaction_ref" VARCHAR(100),
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_transactions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "order_id" UUID,
    "points_change" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- CreateIndex
CREATE INDEX "stock_logs_product_id_created_at_idx" ON "stock_logs"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_logs_created_at_idx" ON "stock_logs"("created_at");

-- CreateIndex
CREATE INDEX "work_schedules_shift_date_idx" ON "work_schedules"("shift_date");

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_employee_id_shift_date_key" ON "work_schedules"("employee_id", "shift_date");

-- CreateIndex
CREATE INDEX "time_logs_employee_id_check_in_idx" ON "time_logs"("employee_id", "check_in");

-- CreateIndex
CREATE INDEX "cash_shifts_status_idx" ON "cash_shifts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "orders_order_type_status_idx" ON "orders"("order_type", "status");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_shift_id_idx" ON "payments"("shift_id");

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- CreateIndex
CREATE INDEX "point_transactions_user_id_created_at_idx" ON "point_transactions"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_logs" ADD CONSTRAINT "time_logs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written section.
--
-- Everything below is required by the SRS but is not expressible in the Prisma
-- schema language: CHECK constraints, a STORED generated column, and a
-- sequence used to mint race-free order numbers. Prisma's `migrate diff` only
-- emits table/index/foreign-key DDL, so these are appended by hand. Because
-- they exist only here, this database must be kept in sync with
-- `prisma migrate deploy` and never `migrate dev` (see README).
-- ---------------------------------------------------------------------------

-- SRS §7 · CHECK (points_balance >= 0)
ALTER TABLE "users"
    ADD CONSTRAINT "chk_users_points_balance_non_negative" CHECK ("points_balance" >= 0);

-- SRS §7 · CHECK (stock_qty >= 0), CHECK (reserved_qty >= 0),
--          CONSTRAINT chk_stock_availability CHECK (stock_qty >= reserved_qty)
ALTER TABLE "products"
    ADD CONSTRAINT "chk_products_stock_qty_non_negative" CHECK ("stock_qty" >= 0),
    ADD CONSTRAINT "chk_products_reserved_qty_non_negative" CHECK ("reserved_qty" >= 0),
    ADD CONSTRAINT "chk_stock_availability" CHECK ("stock_qty" >= "reserved_qty");

-- SRS §7 · CHECK (quantity > 0)
ALTER TABLE "order_items"
    ADD CONSTRAINT "chk_order_items_quantity_positive" CHECK ("quantity" > 0);

-- SRS §7 · CHECK (amount > 0)
ALTER TABLE "payments"
    ADD CONSTRAINT "chk_payments_amount_positive" CHECK ("amount" > 0);

-- SRS §7 · time_logs.work_hours GENERATED ALWAYS AS (...) STORED
-- Deliberately absent from prisma/schema.prisma: Prisma cannot model a
-- generated column, and including it would make every INSERT try to write it.
-- The timesheet report reads it back with $queryRaw.
ALTER TABLE "time_logs"
    ADD COLUMN "work_hours" NUMERIC(5, 2) GENERATED ALWAYS AS (
        ROUND(EXTRACT(EPOCH FROM ("check_out" - "check_in")) / 3600.0, 2)
    ) STORED;

-- Order numbers are minted from a sequence rather than by counting the day's
-- orders, so two simultaneous checkouts can never collide on one number.
-- Rendered as PO-YYYYMMDD-NNNNNN (21 chars, inside orders.order_number VARCHAR(30)).
CREATE SEQUENCE "order_number_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Pickup handover looks an order up by its 4-digit PIN.
CREATE INDEX "idx_orders_pickup_pin" ON "orders" ("pickup_pin") WHERE "pickup_pin" IS NOT NULL;

-- The 15-minute expiry sweeper (SRS §3 Phase 1) scans only unconfirmed orders.
CREATE INDEX "idx_orders_pending_created_at" ON "orders" ("created_at") WHERE "status" = 'pending';
