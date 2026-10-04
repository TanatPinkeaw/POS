-- ------------------------------------------------- a member offers their own goods
--
-- A member who wants to leave goods with the shop fills in the form on their own
-- account page (ADR 0025). There is no Google Form, no Apps Script and no secret:
-- the member is signed in, so the browser is the only caller and the session is the
-- proof. This file is what that form becomes, and the shape of the two tables states
-- the whole design:
--
--   * `consignment_submissions` — one row per offer, describing goods *offered* for
--     consignment. It is not a product and it is not a liability: the share has
--     not been agreed, so nothing is owed until somebody with authority says so. The
--     enum plus the CHECKs below are what make "pending with a product" and
--     "approved without a share" states the database refuses rather than states a
--     later screen has to defend.
--
--   * `consignment_documents` — the photos and the handover paperwork the member
--     attached. One table rather than one pending and one settled, because a document
--     is the same document before and after approval: approval fills in `product_id`
--     and the rows ride along. Two tables would mean copying them and then keeping the
--     copies honest.
--
-- The bytes are the member's, not ours (ADR 0014 extended): `url` is a link, and
-- nothing in this system can be certain what is at the other end of it. That is the
-- same trade a product photo makes, made for the same reason.
--
-- Two deliberate constraints on trust, and both of them are consequences of the
-- member being signed in rather than typing a phone number into somebody else's form:
--
--   * `consignor_user_id` is NOT NULL. The old design kept a phone claim and a
--     nullable owner because a stranger's form answer had to be attributed to
--     *somebody*. Here the session names the person, so the only thing a nullable
--     owner would mean is "the caller was nobody" — which the route refuses.
--   * `client_ref` is UNIQUE and is the idempotency key. A member on a phone double-
--     taps, or the network retries, and a second row would be their goods counted
--     twice in an owner's inbox. The browser mints the key once per form (the same
--     idea as `orders.client_ref` in ADR 0019), so a retry is recognised as the same
--     offer rather than welcomed as a new one.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_offer_submitted';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_submission_approved';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_submission_rejected';
ALTER TYPE "stock_movement_type" ADD VALUE IF NOT EXISTS 'consignment_received';
ALTER TYPE "stock_adjustment_reason" ADD VALUE IF NOT EXISTS 'REASON_CONSIGNMENT';

CREATE TYPE "consignment_submission_status" AS ENUM ('pending', 'approved', 'rejected');
-- The kind is an enum rather than free text because the two values mean different
-- things to a screen: a photo is drawn, a document is opened. A third value added by
-- hand would have to be taught to every reader of this table.
CREATE TYPE "consignment_document_kind" AS ENUM ('photo', 'document');

CREATE TABLE "consignment_submissions" (
  "id"                    UUID                   NOT NULL DEFAULT gen_random_uuid(),
  -- The signed-in member, never null and never a claim somebody typed. Deleting the
  -- account is RESTRICT: a consignment arrangement is a liability to that person.
  "consignor_user_id"     UUID                   NOT NULL,
  -- The key the member's browser minted once for this form. UNIQUE is what makes a
  -- double-tap or a retried request one offer rather than two.
  "client_ref"            UUID                   NOT NULL,
  "product_name"          VARCHAR(150)           NOT NULL,
  "offered_price_thb"     NUMERIC(10, 2)         NOT NULL,
  "quantity"              INTEGER                NOT NULL,
  "notes"                 TEXT,
  "status"                "consignment_submission_status" NOT NULL DEFAULT 'pending',
  -- Filled in by approval. Null while pending, and never set by the member's own
  -- route: offering goods cannot create a product, only offer one.
  "product_id"            UUID,
  "decided_by_user_id"    UUID,
  "decided_at"            TIMESTAMPTZ(6),
  "decided_share_percent" INTEGER,
  "decision_note"         TEXT,
  "submitted_at"          TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "consignment_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_consignment_submissions_quantity" CHECK ("quantity" > 0),
  CONSTRAINT "chk_consignment_submissions_price" CHECK ("offered_price_thb" >= 0),
  -- The share is a percentage of the net, and `consignment-rules` refuses anything
  -- outside 0..100. Stated here too because this table carries money.
  CONSTRAINT "chk_consignment_submissions_share" CHECK (
    "decided_share_percent" IS NULL
    OR ("decided_share_percent" >= 0 AND "decided_share_percent" <= 100)
  ),
  -- Each status carries exactly the columns that status means, so a screen cannot
  -- read "approved" and find nothing decided.
  CONSTRAINT "chk_consignment_submissions_state" CHECK (
    (
      "status" = 'pending'
      AND "product_id" IS NULL
      AND "decided_at" IS NULL
      AND "decided_share_percent" IS NULL
      AND "decision_note" IS NULL
    )
    OR (
      "status" = 'approved'
      AND "product_id" IS NOT NULL
      AND "decided_by_user_id" IS NOT NULL
      AND "decided_at" IS NOT NULL
      AND "decided_share_percent" IS NOT NULL
    )
    OR (
      "status" = 'rejected'
      AND "product_id" IS NULL
      AND "decision_note" IS NOT NULL
    )
  )
);

CREATE TABLE "consignment_documents" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "submission_id" UUID         NOT NULL,
  -- Null while the submission waits, set on approval. "The documents of this
  -- product" is then one indexed column rather than a join through a status.
  "product_id"    UUID,
  "kind"          "consignment_document_kind" NOT NULL,
  "label"         VARCHAR(150) NOT NULL,
  "url"           VARCHAR(500) NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "consignment_documents_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "consignment_submissions"
  ADD CONSTRAINT "consignment_submissions_consignor_user_id_fkey"
  FOREIGN KEY ("consignor_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: the CHECK above says an approved submission must name the
-- product it became, and a cascade that nulls the column would rewrite that row into a
-- state the database has just promised cannot exist — so deleting a product with an
-- approved submission would fail anyway, with a far less obvious message. Refusing the
-- delete is the honest behaviour: the arrangement outlives the row, exactly as a
-- consignor's ledger outlives one sale.
ALTER TABLE "consignment_submissions"
  ADD CONSTRAINT "consignment_submissions_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consignment_submissions"
  ADD CONSTRAINT "consignment_submissions_decided_by_user_id_fkey"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "consignment_documents"
  ADD CONSTRAINT "consignment_documents_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "consignment_submissions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "consignment_documents"
  ADD CONSTRAINT "consignment_documents_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "consignment_submissions_client_ref_key"
  ON "consignment_submissions"("client_ref");

CREATE INDEX "consignment_submissions_status_submitted_at_idx"
  ON "consignment_submissions"("status", "submitted_at");

CREATE INDEX "consignment_submissions_consignor_user_id_idx"
  ON "consignment_submissions"("consignor_user_id");

CREATE INDEX "consignment_documents_submission_id_idx"
  ON "consignment_documents"("submission_id");

CREATE INDEX "consignment_documents_product_id_idx"
  ON "consignment_documents"("product_id");
