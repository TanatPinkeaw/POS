-- ------------------------------------------------- a customer's messages (ADR 0032)
--
-- The webhook has received `message` events since ADR 0030 and recorded nothing: the
-- only things it acted on were the two halves of the friend condition. That left the
-- one channel the shop's customers actually use carrying no history this system can
-- read — so "what did this customer ask us" had no answer at the counter.
--
-- One row per message, and the two columns that make it trustworthy rather than a log:
--
-- * `line_message_id` is LINE's own message id, UNIQUE. LINE redelivers a webhook it did
--   not receive a 2xx for, so a redelivery must be a no-op; keying on the platform's own
--   identifier is exactly what `inbound_payments` does with the bank's `Message-ID`, and
--   for the same reason — the sender's id is the only one that cannot be invented twice.
-- * `user_id` is the customer this message resolved to, or null when nobody holds the
--   LINE account. Nullable with `ON DELETE SET NULL`: deleting a customer must not erase
--   the shop's record of what was asked, and the subject column still names the thread.
--
-- `message_type` is a closed set with one forward-compatible door (`other`), enforced here
-- rather than only in code: LINE adds message types, and an unknown type must be *stored*
-- as unknown rather than refused, because a refused webhook is one LINE retries forever.
--
-- No bytes are stored for a non-text message, and the CHECK states the pairing rather than
-- leaving it to the application: `text` is present if and only if the message is a text
-- message. That is the same shape `inbound_payments.amount` carries for
-- `amount_unreadable` — a column that means one thing, never two.
--
-- Retention is deliberate and has no window: this is customer data kept like an order,
-- which is why the PDPA posture (CONTEXT item 9) names it.

CREATE TABLE "line_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "line_message_id" VARCHAR(120) NOT NULL,
    "line_subject" VARCHAR(120) NOT NULL,
    "user_id" UUID,
    "message_type" VARCHAR(20) NOT NULL,
    "text" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "line_messages_type_check" CHECK (
        "message_type" IN ('text', 'image', 'video', 'audio', 'file', 'location', 'sticker', 'other')
    ),
    CONSTRAINT "line_messages_text_check" CHECK (("message_type" = 'text') = ("text" IS NOT NULL))
);

CREATE UNIQUE INDEX "line_messages_line_message_id_key" ON "line_messages"("line_message_id");

-- What a customer's card reads: their messages, newest first.
CREATE INDEX "line_messages_user_id_received_at_idx" ON "line_messages"("user_id", "received_at" DESC);

-- What anything reading the log as a whole reads, and what a future retention rule would
-- scan: the newest messages first, regardless of who sent them.
CREATE INDEX "line_messages_received_at_idx" ON "line_messages"("received_at" DESC);

ALTER TABLE "line_messages"
  ADD CONSTRAINT "line_messages_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
