-- ------------------------------------ a fact that repeats, on a window (ADR 0032 §4)
--
-- The outbox dedupes a fact about an order on `(kind, order_id)`, and a fact about
-- something that is not an order on `(kind, recipient)` — which is "once ever", and
-- correct for the two facts that used it: a refund, and a bank transfer dismissed by
-- hand. Neither of those can happen twice and mean two things.
--
-- A customer writing to the shop is the first fact that *should* repeat: one per burst
-- is what a shop wants to hear, and one ever would mean the group heard about a
-- customer once and never again. The key therefore carries the window (`subject:bucket`)
-- and lives in its own column, so
--
--   * the window is enforced by a unique index and not by a read two workers could both
--     win — the same reasoning the call-number pair and the rate-limiter buckets use;
--   * `recipient` stays what it has always been (where the message goes), rather than
--     being overloaded to carry a subject it does not denote.
--
-- Nulls are distinct in a Postgres unique index, so every existing row — and every future
-- row planned without a key — is unaffected by this constraint. The `(kind, order_id)`
-- index stays exactly as it was.

ALTER TABLE "notifications" ADD COLUMN "dedupe_key" VARCHAR(160);

CREATE UNIQUE INDEX "notifications_kind_dedupe_key_key" ON "notifications"("kind", "dedupe_key");
