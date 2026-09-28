-- ------------------------------------------------------- notification outbox
--
-- A message that should go out, written in the transaction that made it true.
--
-- Hand-written like every migration here (`prisma migrate deploy`; see the note in
-- 20260106000000_credit_notes_and_refunds). What the database enforces, rather
-- than application code:
--
--   1. **One message per fact.** `UNIQUE (kind, order_id)` means "your order is
--      ready" cannot be queued twice by a retried request, a double click or a
--      second worker pass. The dedupe belongs here because the sender is a script
--      that may be run by hand, by cron, or twice by accident.
--   2. **Sent means sent.** `sent_at` and the status are the same fact, checked in
--      both directions below, so a row cannot claim delivery it cannot timestamp.
--   3. **A failure says what happened.** An abandoned row has no `sent_at` and
--      must carry the error that stopped it: a row nobody can diagnose is a row
--      nobody can fix.

CREATE TYPE "notification_channel" AS ENUM ('line', 'webhook');

CREATE TYPE "notification_status" AS ENUM (
    'pending',
    -- Delivered. `sent_at` is set, and the CHECK below ties the two together.
    'sent',
    -- Out of attempts: six tries over eight hours, all failing the same way. Its
    -- own state so that a misconfigured shop sees a pile of rows with a reason,
    -- rather than a worker that retries them until somebody notices the log.
    'abandoned'
);

CREATE TABLE "notifications" (
    "id"              BIGSERIAL              NOT NULL,
    "kind"            VARCHAR(40)            NOT NULL,
    "channel"         "notification_channel" NOT NULL,
    -- Deliberately not a foreign key onto `users.phone`: this is whatever the
    -- channel needs to address — a phone number for a gateway, a group id for
    -- LINE — and a group is not a person. Tying it to a user would make the shop's
    -- own group unrepresentable.
    "recipient"       VARCHAR(120)           NOT NULL,
    -- The message as it will be sent. Rendered when the fact was fresh, so editing
    -- the wording tomorrow cannot rewrite what a customer was told yesterday.
    "body"            TEXT                   NOT NULL,
    "status"          "notification_status"  NOT NULL DEFAULT 'pending',
    -- Tries so far, and when the next one is due. A worker moves
    -- `next_attempt_at` forward *before* it sends, so a worker killed mid-send
    -- leaves a row that returns rather than one stuck in flight forever.
    "attempts"        INTEGER                NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error"      TEXT,
    -- Cascade, unlike the RESTRICT used everywhere money is involved: this is a
    -- record of a *message*, not of money or authority, and an order that is
    -- hard-deleted (which only the seed does) takes its undelivered notices with
    -- it rather than blocking the delete.
    "order_id"        UUID,
    "created_at"      TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"         TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Nulls are distinct in a PostgreSQL unique index, so nothing here blocks a future
-- message that is not about one order.
CREATE UNIQUE INDEX "notifications_kind_order_id_key"
    ON "notifications"("kind", "order_id");

-- The worker's only query: what is due, oldest first.
CREATE INDEX "notifications_status_next_attempt_at_idx"
    ON "notifications"("status", "next_attempt_at");

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
    ADD CONSTRAINT "chk_notifications_sent_has_timestamp"
    CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

-- One direction: an abandoned row must say why. Deliberately not an equality —
-- a message may fail twice and then succeed, and its third attempt keeps both the
-- timestamp and the history of the two errors that preceded it.
ALTER TABLE "notifications"
    ADD CONSTRAINT "chk_notifications_abandoned_has_reason"
    CHECK ("status" <> 'abandoned' OR "last_error" IS NOT NULL);

-- Something was actually attempted before a row can be finished with, either way.
-- A 'sent' row with zero attempts, or an 'abandoned' one, would mean a status was
-- written without a send ever happening.
ALTER TABLE "notifications"
    ADD CONSTRAINT "chk_notifications_finished_attempted"
    CHECK ("status" = 'pending' OR "attempts" > 0);
