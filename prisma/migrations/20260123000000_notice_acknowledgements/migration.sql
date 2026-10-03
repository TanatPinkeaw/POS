-- ------------------------------------------------- what a customer was told, and when
--
-- A shop is required to inform its customers what it does with their data. A customer
-- who signs up online is told at the moment they sign up (`CustomerSignIn`), and this
-- table is the shop's proof that it told them. `docs/pdpa-research.md` found the
-- missing-requirements list did not include any way of showing a notice had been given;
-- this closes that part of it.
--
-- **A table rather than a column on `users`.** An acknowledgement is evidence, and
-- evidence that the next signup overwrites is not evidence. The notice *will* be edited
-- — its retention periods follow the shop's configuration, and its effective date is a
-- literal precisely because it has to move in the same commit as the change — so a
-- column would quietly rewrite what an earlier customer agreed to. Here, a customer who
-- acknowledged the September text keeps that row after the notice is revised, and the
-- shop can still say exactly what they were shown on the day they signed up.
--
-- **`notice_version` is the effective date of the text, not a counter.** `src/lib/
-- privacy-notice.ts` derives one from the other, so a version bumped without a new date
-- — or the reverse — cannot produce a row that looks current and is not. The signup
-- route refuses any version that is not the current one, which is what makes the row
-- mean "this exact text was on the notice when this happened".
--
-- **`customer_user_id` is ON DELETE RESTRICT, not CASCADE.** Every other table that
-- points at a person cascades, because losing the person should lose their rows. This
-- one must not: it is the record that a data subject was informed, and it has to
-- outlive the account it is about. That is also the honest answer to a deletion request
-- that reaches this far — the shop keeps the proof, not the person, since the row
-- carries an id and a date and nothing else about them.
--
-- **`notice_url` is where the text lived, not a copy of it.** The notice is rendered
-- from the shop's own row, so it never sat at a fixed address like `/privacy/v1.pdf`;
-- the path recorded is the path it was read at. Keeping the pointer and not the text is
-- what keeps this table from becoming a second, drifting copy of the notice — the
-- failure `offline-shell.test.ts` refuses when it reads a twin of `public/sw.js`.

CREATE TABLE "notice_acknowledgements" (
  "id"               BIGSERIAL    NOT NULL,
  "customer_user_id" UUID         NOT NULL,
  "notice_version"   VARCHAR(10)  NOT NULL,
  "notice_url"       VARCHAR(120) NOT NULL DEFAULT '/privacy',
  "acknowledged_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notice_acknowledgements_pkey" PRIMARY KEY ("id"),
  -- The shop records the instant it was told, not the instant the customer clicked.
  -- A clock on the server is the only one a shop can defend; a browser clock is a
  -- number the customer chose.
  CONSTRAINT "chk_notice_ack_claimed_future" CHECK ("acknowledged_at" <= now() + INTERVAL '5 minutes')
);

-- Which version this customer has acknowledged, newest first.
--
-- The index is on `(customer_user_id, acknowledged_at DESC)` rather than a partial index
-- on the current version, because the current version is a value in application code
-- and a partial index cannot be written against a constant it does not know. The
-- opposite order is chosen deliberately: the question is always "what did they last
-- see", and answering it from the end of a short per-person list is cheaper than
-- scanning for one matching version.
CREATE INDEX "notice_acknowledgements_customer_recent"
  ON "notice_acknowledgements" ("customer_user_id", "acknowledged_at" DESC);

-- A version is a date, and the CHECK is what makes it one.
--
-- Without it, a refactor that moved `CUSTOMER_NOTICE_VERSION` to a semantic version
-- ("v2") would keep writing rows happily, and the table would hold a mix of two
-- formats that still *looked* sortable. The format is the invariant that lets the shop
-- compare a stored version against the current one with `=`.
ALTER TABLE "notice_acknowledgements"
  ADD CONSTRAINT "chk_notice_ack_version_is_date" CHECK ("notice_version" ~ '^\d{4}-\d{2}-\d{2}$');

ALTER TABLE "notice_acknowledgements"
  ADD CONSTRAINT "notice_acknowledgements_customer_fkey"
  FOREIGN KEY ("customer_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;