# 03 — Messages: planners, enqueue points, webhook

**Blocking:** 04 (the card quotes the friend condition the webhook enforces).

**Built:**

- `src/lib/line-notify.ts` — the audience planner, pure:
  `lineCustomerNotifyBlock` (four named reasons),
  `planLineCustomerReadyMessage` (customer's own subject only; the shop's group
  is never a fallback — ADR 0007 decision 3 kept),
  `planShopFactMessage` (refund fact, deduped on the order),
  `planShopInboundDismissedMessage` (deduped on the transfer id riding the
  recipient column), `LINE_CONSENT_VERSION`.
- `src/lib/notify-message.ts` — `PlannedNotification.orderId` widened to
  `string | null` (nulls are distinct in the unique index, so a fact about a
  transfer never collides with an order-keyed message); `ShopFactKind` named
  beside the existing kinds.
- `src/lib/notify-outbox.ts` — the dedupe read mirrors whichever shape the plan
  names (order or recipient).
- Enqueue points, inside the transactions that made the facts true:
  `markOrderReady` (customer LINE facts read beside the phone; friend row read
  outside the pure planner), `refundOrder`, `dismissInboundTransfer`.
- `src/app/api/v1/line/webhook/route.ts` + `src/lib/line-webhook-signature.ts`:
  raw body read once, HMAC verified with `node:crypto` + `timingSafeEqual`
  (jose speaks JWS; LINE's signature is a bare HMAC — forcing it into a JWS
  envelope would be ceremony), limiter before the work, `follow`/`unfollow`
  write `line_friends`, everything else answered 200 and ignored, unconfigured =
  not a door. Policy `line_webhook`.

**Acceptance, met:** `tests/line-notify.test.ts` (every null named; the
group-never-gets-the-code case pinned; the unreadable amount never becomes a
number), `tests/line-outbox.test.ts` against real Postgres (one row per refund
however retried; per-transfer dedupe; no null-order collision).
