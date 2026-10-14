-- ------------------------------------------------ LINE campaigns (ADR 0032 §6, §7)
--
-- One campaign and its batches, written **before anything is sent** — the same shape the
-- notification outbox takes. Two facts, and they are not the same one: what the shop decided
-- to send, and what actually went out. A dispatch that exists only in a log line cannot
-- answer "who got this promotion" a week later.
--
-- The batch is the unit that succeeds or fails, because it is the unit LINE accepts:
-- `POST /v2/bot/message/multicast` takes at most 500 user ids per request and is counted per
-- recipient against the month's allowance (300 messages on the free plan for Thailand). So
-- `recipient_ids text[]` is exactly the list that will be handed to LINE, and `batch_index`
-- is how a reader puts the batches back in the order they went out.
--
-- **At most once** is a property of this table rather than a hope: LINE's multicast takes no
-- idempotency key, so a retry cannot be told apart from a fresh send, and a promotion
-- delivered twice to five hundred people is worse than one an admin has to press again. A
-- batch moves `pending → sent | failed` once, and the failure is recorded on the row with
-- LINE's own words (including `429 You have reached your monthly limit.`).
--
-- `recipient_count` and `quota_remaining_at_send` are measurements, not the authority: there
-- is no live friend-count API, so the count is this deployment's own eligible customers, and
-- LINE's quota read can say one thing while LINE refuses the send with the monthly-limit
-- error. The refusal on the batch is what a later reader trusts.

CREATE TABLE "line_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "body" TEXT NOT NULL,
    "image_url" VARCHAR(500),
    "sent_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "quota_remaining_at_send" INTEGER,
    "failure_reason" VARCHAR(500),

    CONSTRAINT "line_campaigns_pkey" PRIMARY KEY ("id"),
    -- The same closed set the module writes, enforced here so a bug cannot invent a state a
    -- screen has no sentence for.
    CONSTRAINT "line_campaigns_status_check" CHECK (
        "status" IN ('pending', 'sent', 'partial', 'failed')
    ),
    CONSTRAINT "line_campaigns_recipient_count_check" CHECK ("recipient_count" >= 0)
);

CREATE INDEX "line_campaigns_created_at_idx" ON "line_campaigns"("created_at" DESC);

ALTER TABLE "line_campaigns"
  ADD CONSTRAINT "line_campaigns_sent_by_user_id_fkey"
  FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "line_campaign_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "recipient_ids" TEXT[] NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "attempted_at" TIMESTAMPTZ(6),
    "error" VARCHAR(500),

    CONSTRAINT "line_campaign_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "line_campaign_batches_status_check" CHECK (
        "status" IN ('pending', 'sent', 'failed')
    ),
    -- LINE's documented cap, stated where the data lives rather than only in the planner: a
    -- batch of 501 would be refused by LINE after the shop had already been told it was
    -- queued, which is the wrong order to find out in.
    CONSTRAINT "line_campaign_batches_size_check" CHECK (cardinality("recipient_ids") BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX "line_campaign_batches_campaign_id_batch_index_key"
  ON "line_campaign_batches"("campaign_id", "batch_index");

-- What the worker scans for: due batches, oldest first.
CREATE INDEX "line_campaign_batches_status_id_idx" ON "line_campaign_batches"("status", "id");

ALTER TABLE "line_campaign_batches"
  ADD CONSTRAINT "line_campaign_batches_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "line_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Read by the plugin's own administrator screen and by the trail's own vocabulary. Added in
-- the same migration as the table it describes, for the reason ADR 0030's two LINE values
-- were: the trail and the act must not be able to disagree.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'line_campaign_sent';
