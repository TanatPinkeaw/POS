-- ------------------------------------ promotion consent is its own fact (ADR 0032 §5)
--
-- `line_consent_at` already exists and means one thing: "tell me about my own order".
-- A customer asks for that by placing the order, so it is a consequence of an act they
-- already took. A promotion is a different purpose, and PDPA-style honesty needs the shop
-- to be able to say who agreed to *what* and when — so it gets its own timestamp, and the
-- sentence the account page prints about order notifications keeps meaning exactly what
-- the customer agreed to.
--
-- Two timestamps instead of a boolean, and this is the whole reason for the shape: a
-- boolean cannot tell "never asked" (both null) from "said no" (withdrawn set). Those two
-- need different sentences on the customer's screen — one offers the choice, the other
-- must not offer it again — and one column must not mean two things.
--
-- No backfill: `line_promo_consent_at` was never asked of anybody before this statement,
-- so null is exactly true for every row that already exists. Withdrawing is an act, not a
-- deletion: the timestamp is what records it, and agreeing again afterwards writes a later
-- one. Which of the two wins is decided in one pure function
-- (`src/lib/line-promo-consent.ts`), not by a reader comparing two columns by eye.
--
-- A fresh LINE binding leaves all three null — consent to promotions is never a side
-- effect of binding an account, and a test pins that.

ALTER TABLE "users"
  ADD COLUMN "line_promo_consent_at" TIMESTAMPTZ(6),
  ADD COLUMN "line_promo_withdrawn_at" TIMESTAMPTZ(6),
  ADD COLUMN "line_promo_consent_version" VARCHAR(40);
