# 07: A campaign is sent once, and a batch that failed waits for a person

**What to build:** The one door that sends a campaign, and the worker behaviour that
delivers its batches — at most once each, with the reason recorded when one does not.

**Blocked by:** 06.
**Status:** done

- [ ] `POST /api/v1/admin/line/campaigns` — `requireRole(['admin'])`, an audit row
      (`line_campaign_sent`, with the recipient count and the message's own first words),
      and the limiter (a signed-in write that costs money per recipient is exactly the
      shape `member_create` already established as worth counting). One transaction:
      compute the eligible set, read the month's remaining allowance, refuse if it cannot
      pay, then write the campaign and its batches. Nothing is sent inside the request.
- [ ] The refusals are Thai and each says what to do: nothing to send to (with the
      counts that produced it), the month's allowance is short (with both numbers), LINE
      is not configured, the image link is not drawable.
- [ ] Sending happens in `scripts/notify-worker.ts`'s pass, beside the outbox rows it
      already drains: due batches go out through **multicast** in batches of ≤500, and a
      batch's outcome is written on the batch row.
- [ ] **At most once**, and this is the decision the ADR argues: LINE's multicast takes
      no idempotency key, so a retry cannot be told apart from a fresh send — and a
      promotion delivered twice to 500 people is worse than one that needs an admin to
      press again. A failed batch is marked failed with LINE's own words (including
      `429 You have reached your monthly limit.`) and **is never retried automatically**.
- [ ] The campaign's status follows its batches: `sent` when every batch went,
      `partial` when some did, `failed` when none did. `partial` is the state a shop must
      be able to see, because that is a message some customers got and others did not.
- [ ] `LINE_API_BASE_URL` is the only seam needed for tests; the worker's transport for a
      campaign lives in `notify-channel.ts` beside the push it already does, so there is
      still one file that knows how to talk to LINE.
- [ ] Tests against real Postgres and a stub LINE endpoint: a campaign sends `ceil(n/500)`
      requests with LINE's documented body shape; a 429 on the second batch leaves the
      first `sent` and the second `failed` with the campaign `partial`; re-running the
      worker sends nothing again.

## Notes

**Why the composer's arithmetic is not the authority.** LINE's own documentation warns
that a send can be refused with the monthly-limit error while the console still shows
messages remaining. So the pre-check is a courtesy and a measurement, and the authority
is the refusal recorded on the batch — which is exactly why the failure is a row and not
a log line.
