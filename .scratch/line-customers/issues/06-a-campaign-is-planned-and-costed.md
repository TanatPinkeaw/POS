# 06: A campaign is planned, split into batches, and costed before it is sent

**What to build:** One module that answers "who gets this, in what batches, and what does
it cost", one reader that asks LINE how much of the month is left, and the two rows that
record a campaign and its batches.

**Blocked by:** 05 (eligibility is the promotion consent; the schema would be guessing
at it otherwise).
**Status:** done

- [ ] `src/lib/line-campaign-rules.ts` — **pure**, no I/O:
      - `eligibleCampaignRecipients(...)` from the facts the caller read (subject bound,
        promo consent state `consented`, a `line_friends` row) — the same "the friend row
        arrives as a parameter" shape `lineCustomerNotifyBlock` uses, so the decision is
        testable without a database;
      - `planCampaignBatches(subjects, maxPerRequest = 500)` — **≤500 user ids per
        request**, LINE's documented cap, in stable order so a run is reproducible;
      - `campaignCostCents`-style arithmetic in whole messages: **one message per
        recipient**, and a `campaignAffordable(remaining, recipients)` that answers
        whether the month's allowance can pay for it.
- [ ] Schema + migration: `line_campaigns` (`id`, `body`, nullable `image_url`,
      `sent_by_user_id`, `created_at`, `status`, `recipient_count`, `quota_remaining_at_send`,
      nullable `failure_reason`) and `line_campaign_batches` (`id`, `campaign_id`,
      `batch_index`, `recipient_ids` (text[]), `status`, `attempted_at`, nullable
      `error`). The batch is the unit that succeeds or fails, because that is the unit
      LINE accepts.
- [ ] `src/lib/line-quota.ts` — reads `GET /v2/bot/message/quota` and
      `GET …/quota/consumption` with `NOTIFY_LINE_TOKEN`, returning
      `{limited: boolean, limit: number|null, consumed: number, remaining: number|null}`,
      and `null` when the token is unset. It reads **the deployment's configured LINE
      address**, overridable with `LINE_API_BASE_URL` for the acceptance run — the same
      recorded trade as `LINE_TOKEN_URL` and `LINE_JWKS_URL` (ADR 0030 §6): whoever sets
      it moves where this server sends the shop's channel token, so it is set from the
      same `.env` that already holds the secret. Documented in `.env.example` with that
      warning.
- [ ] The **reachable count comes from this deployment's own rows**, never from LINE:
      there is no live friend-count API (only a date-based insight endpoint whose
      eligibility could not be confirmed), so the composer's number is a count of our
      own eligible customers and the ADR says why.
- [ ] Tests: pure (batches split at exactly 500 with no empty tail; an ineligible
      customer is excluded for each of the four named reasons; affordability at the
      boundary), and against real Postgres (a campaign and its batches round-trip; the
      eligible set is the consented friends and nobody else). `line-quota.ts` is tested
      against a stub base URL served by the test itself, including a 429 and an
      unconfigured token.

## Notes

**Why not LINE's `/broadcast`.** It reaches every friend of the Official Account and
takes no recipient list, so it cannot honour the shop's own rule — consent *and* friend
(ADR 0030 §2). "Broadcast" in this product means multicast to the shop's own list; the
ADR records that as a corrected word rather than a lost feature.

**Why the cost is a first-class number.** The free plan is 300 messages a month and
counting is per recipient: a campaign to 250 customers spends 250 of it. A shop that
cannot see that before pressing send finds out by being refused, which is the failure
the composer exists to make visible.
