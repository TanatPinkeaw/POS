-- ------------------------------------------------------- inbound bank transfers
--
-- Money the bank says arrived, recorded whether or not it can be attributed.
--
-- Hand-written like every migration here (`prisma migrate deploy`; see the note
-- in 20260106000000_credit_notes_and_refunds). Three decisions are expressed in
-- the database rather than in application code:
--
--   1. **A message is recorded once.** `UNIQUE (source, external_id)` means a
--      retrying bridge cannot double-count money. The bridge is a shell script on
--      somebody's shop network; the guarantee belongs here.
--   2. **A matched row names a real QR.** The foreign key onto
--      `payment_intents.ref` plus the CHECK below make "matched" a statement the
--      database can verify, not a string that used to be a reference.
--   3. **The reason a row is unattributed is not optional.** `unmatched` with no
--      `refusal_reason` would be a row nobody can act on, which is the same as
--      having no row at all.

-- The one gated action in this path: a person saying "that transfer is not ours".
-- Automated matches are not audited, because the bank's own notification is the
-- authority for them; a dismissal has only somebody's word, so it gets a row.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'inbound_transfer_dismissed';

CREATE TYPE "inbound_payment_status" AS ENUM ('matched', 'unmatched', 'dismissed');

CREATE TYPE "inbound_refusal_reason" AS ENUM (
    -- The bridge could not read an amount out of the notification at all. Its own
    -- decision, recorded here so the money is still visible rather than dropped by
    -- a script that decided it could not deal with it.
    'amount_unreadable',
    'no_amount_match',
    'no_reference',
    'ambiguous',
    'not_payable'
);

CREATE TABLE "inbound_payments" (
    "id"                   BIGSERIAL              NOT NULL,
    -- Nullable, and the null means one specific thing: the notification did not
    -- contain a number anybody could read (see the CHECK below). Writing a
    -- placeholder — a zero, a satang — would put a made-up amount in a money
    -- column, which is the one thing this table must never do.
    "amount"               DECIMAL(10,2),
    -- The bank's instant, not ours. Payability is judged against this.
    "received_at"          TIMESTAMPTZ(6)         NOT NULL,
    "source"               VARCHAR(40)            NOT NULL,
    -- The bank's identifier for the message, for idempotency. Nullable: a source
    -- that has no such identifier (a person pasting a screenshot) is still valid,
    -- and PostgreSQL's unique index ignores nulls rather than colliding on them.
    "external_id"          VARCHAR(200),
    "raw_text"             TEXT                   NOT NULL,
    "status"               "inbound_payment_status" NOT NULL DEFAULT 'unmatched',
    "refusal_reason"       "inbound_refusal_reason",
    "intent_ref"           VARCHAR(12),
    "dismissed_reason"     TEXT,
    "dismissed_by_user_id" UUID,
    "dismissed_at"         TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_payments_source_external_id_key"
    ON "inbound_payments"("source", "external_id");

-- The screen asks one question — what still needs a person — so the index answers
-- that one and nothing else.
CREATE INDEX "inbound_payments_status_received_at_idx"
    ON "inbound_payments"("status", "received_at");

ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "inbound_payments_intent_ref_fkey"
        FOREIGN KEY ("intent_ref") REFERENCES "payment_intents"("ref")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "inbound_payments_dismissed_by_user_id_fkey"
        FOREIGN KEY ("dismissed_by_user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT on both, for the same reason `payments.credit_note_id` is restricted:
-- deleting the QR a transfer closed, or the account that dismissed one, would
-- leave money in the bank with nothing explaining where it went.

ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "chk_inbound_payments_amount_positive"
    CHECK ("amount" IS NULL OR "amount" > 0);

-- An absent amount and the reason for it are the same fact, stated both ways:
-- money is only ever recorded without a figure when the figure could not be read.
-- That also stops a *matched* row from having no amount, since a matched row's
-- reason is null and null is not 'amount_unreadable'.
ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "chk_inbound_payments_amount_present_unless_unreadable"
    CHECK (("amount" IS NULL) = ("refusal_reason" = 'amount_unreadable'));

-- One statement per status, written as an equality between two booleans so each
-- reads as the sentence it is, and so a fourth status has to confront all three
-- rather than slip through a default.
ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "chk_inbound_payments_matched_names_intent"
    CHECK (("status" = 'matched') = ("intent_ref" IS NOT NULL));

-- One direction, not an equality, and the difference is a dismissal: a person
-- writing money off keeps *both* reasons — why the system would not attribute it
-- and why they decided it was not ours. An equality would have forced the machine's
-- reason to be erased to record the human one, which is exactly the history the
-- trail exists to keep.
ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "chk_inbound_payments_unmatched_has_reason"
    CHECK ("status" <> 'unmatched' OR "refusal_reason" IS NOT NULL);

ALTER TABLE "inbound_payments"
    ADD CONSTRAINT "chk_inbound_payments_dismissed_has_actor"
    CHECK (
        ("status" = 'dismissed')
        = ("dismissed_by_user_id" IS NOT NULL AND "dismissed_reason" IS NOT NULL)
    );
