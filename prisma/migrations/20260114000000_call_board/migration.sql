-- --------------------------------------------------------------- call board
--
-- A walk-in sale is paid and `completed` in the same instant, and the drink is
-- still being made. Everything this system knew about the order was therefore
-- finished while the shop's own work was not, and no screen could say which
-- numbers are on the bar. This column is that missing fact. ADR 0018 is the
-- decision, including why it is a second state machine rather than a new
-- `order_status` value: `completed` is what every sales report, refund and
-- reconciliation counts, and a drink waiting to be made is not a different kind of
-- money.
--
-- Nullable on purpose, and the null is a fact rather than an absence: a pre-order
-- has no goods waiting (its handover *is* its payment), and every bill written
-- before this migration had no board to be on. `preparing` is written by
-- `createPosSale`, in the same transaction that closes the bill, so a ticket can
-- never exist without a bill that was paid.
--
-- No `fulfilment_at` column: `completed_at` is when the ticket started and
-- `ready_at` — which a pre-order already uses for the same fact — is when the goods
-- became collectable. A third timestamp saying "when the state last changed" would
-- be a second answer to a question the row already answers twice.
CREATE TYPE "fulfilment_state" AS ENUM ('preparing', 'ready', 'collected');

ALTER TABLE "orders" ADD COLUMN "fulfilment" "fulfilment_state";

-- The board's query — today's bills whose goods are not handed over yet. A plain
-- index rather than a partial one because Prisma cannot express `WHERE fulfilment
-- IS NOT NULL` in the schema, and the two must agree: an index that exists only in
-- this file is an index the next `prisma migrate dev` will drop.
CREATE INDEX "orders_fulfilment_idx" ON "orders"("fulfilment");
