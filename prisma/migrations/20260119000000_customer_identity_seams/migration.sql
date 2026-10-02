-- --------------------------------------------------- a Google door and an OTP (ADR 0020)
--
-- Two seams for the customer sign-in work, and both are additive on purpose: the
-- counter flow (ADR 0011) keeps working untouched, because Google is an extra door
-- and never the only one.
--
--   * `users.google_subject` — the subject id from a verified Google id token,
--     nullable because most customers arrive at the counter and never have one, and
--     `UNIQUE` because the entire point of storing it is that a returning Google
--     account resolves to the *same* customer rather than a second row that splits
--     the points ledger (ADR 0020 §4). A partial index is unnecessary: Postgres
--     already treats every NULL as distinct, so any number of counter-enrolled
--     customers can share the "no Google identity" state.
--
--   * `otp_challenges` — one live phone-ownership challenge per number, keyed by the
--     phone, so a new send replaces the old code instead of leaving two valid ones.
--     The code is hashed (a six-digit secret is one million values, not a password),
--     with an expiry and an attempt counter. No foreign key to `users`: the OTP
--     proves possession of a phone before we know whether it is already a customer,
--     which is exactly the order ticket 02 needs for a first signup and a link alike.

ALTER TABLE "users" ADD COLUMN "google_subject" VARCHAR(255);
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");

CREATE TABLE "otp_challenges" (
  "phone"       VARCHAR(20)  NOT NULL,
  "code_hash"   VARCHAR(255) NOT NULL,
  "attempts"    INTEGER      NOT NULL DEFAULT 0,
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("phone")
);
