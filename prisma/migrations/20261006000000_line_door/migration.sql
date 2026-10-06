-- ------------------------------------------------------------ a LINE door (ADR 0030)
--
-- Three nullable facts on the customer row and one table beside it, and each is
-- shaped by ADR 0020's Google column rather than invented here:
--
-- * `line_subject` is the subject from a verified LINE Login id token. Unique, so
--   one LINE account cannot bind two customers; nullable, so the counter flow and
--   every customer who never touched LINE are untouched by this migration. Backfill
--   is neither needed nor possible: nobody had a LINE subject before this statement.
-- * `line_consent_at` + `line_consent_version` record *when* the customer agreed to
--   be notified on LINE and under which text. A timestamp rather than a flag so
--   "never asked" (null) is distinct from any answer. There is no "no" state: the
--   withdrawal clears the subject and the consent together, which is the strongest
--   form of "stop messaging me" and also the easiest to explain.
--
-- `line_friends` is the shop's half of the consent pair (ADR 0030 §2): a LINE push
-- is only delivered to friends of the Official Account, an unfollowed user's push
-- is refused with a 200, and planning a message for one would burn the outbox's
-- whole retry schedule against a door nobody is behind. The webhook's `follow`
-- event writes the row, `unfollow` deletes it, and the customer planner reads it
-- beside the consent it sits beside. Keyed by the subject so a customer can be
-- followed before they finish binding, and the row is here waiting when they do.
-- Deliberately standalone with no foreign key, like `otp_challenges`: the webhook
-- writes and clears it by subject alone, before any binding exists.

ALTER TABLE "users"
  ADD COLUMN "line_subject" VARCHAR(120),
  ADD COLUMN "line_consent_at" TIMESTAMPTZ(6),
  ADD COLUMN "line_consent_version" VARCHAR(40);

/*
 * Two new audit actions (ADR 0030). An enum rather than a free-text code, for the
 * reason the rest of this vocabulary is one: "which LINE accounts may sign in as
 * which customer" is a question the trail answers, and a vocabulary that can
 * drift silently is not a trail. Adding the values in the same migration as the
 * columns they describe keeps the trail and the door from disagreeing.
 */
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'line_bound';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'line_unbound';

CREATE UNIQUE INDEX "users_line_subject_key" ON "users"("line_subject");

CREATE TABLE "line_friends" (
    "line_subject" VARCHAR(120) NOT NULL,
    "followed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_friends_pkey" PRIMARY KEY ("line_subject")
);
