-- ------------------------------------------------------------ offline replay
--
-- The two columns that let a bill closed with no connection reach the shop without
-- being invented twice and without being filed under the wrong day (ADR 0019
-- decisions 4 and 5).
--
-- `client_ref` is the bill's identity as the *device* sees it: a UUID the till
-- generated when it printed the slip. The unique index is the double-charge guard —
-- a retry after a timeout, a batch sent twice, a bridge that repeats itself all
-- insert once and are refused the second time — and it is the same shape as
-- `credit_notes (order_id, sequence)`: the API path checks, the database is what
-- makes it true. Null on every bill the server witnessed, so "was this recorded
-- offline" is answered by `client_ref IS NOT NULL` rather than by a second flag that
-- could drift.
--
-- `sold_at` is the instant the sale happened for the books. `created_at` is the
-- moment the server *learned* about the bill, which is exactly wrong for a replay: a
-- 21:00 sale synced at 08:12 is yesterday's takings, and a daily reconciliation that
-- moves money between days is one nobody can close. `completed_at` could not carry
-- this either, because it is a lifecycle timestamp — the same instant for a walk-in
-- sale, and the moment of handover for a pre-order.
--
-- The column is non-null from the first moment because every existing row has an
-- honest answer: it was sold when it was created. The default is then kept, so an
-- ordinary sale needs no special case; the replay passes the device's instant
-- explicitly, and `completeOrder` passes the handover instant for a pre-order.
-- Nothing reads it on an order that has no sale yet — every day-bucketed query also
-- filters on a terminal status, so a pending pre-order's value is never a takings
-- figure.
--
-- The index is the one the reports' date ranges use. `created_at` keeps its own,
-- because the orders that have no sale instant (the pending pre-orders the expiry
-- sweeper looks for, the newest-first list on the dashboard) still ask for it.
ALTER TABLE "orders" ADD COLUMN "client_ref" TEXT;
ALTER TABLE "orders" ADD COLUMN "sold_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "orders" SET "sold_at" = "created_at";

CREATE UNIQUE INDEX "orders_client_ref_key" ON "orders"("client_ref");
CREATE INDEX "orders_sold_at_idx" ON "orders"("sold_at");

-- A bill that was closed with no connection reached the shop. Its own action rather than
-- a note on the sale: the printed slip and the record can differ — a price
-- the shop has since changed, a tax rate that moved during the outage — and this row is
-- what turns that difference into an explanation instead of a rumour.
--
-- Added here and used only by code, never by a statement in this file: PostgreSQL
-- refuses to use a value added to an enum inside the same transaction, which is the
-- transaction this migration runs in.
ALTER TYPE "audit_action" ADD VALUE 'offline_sale_synced';
