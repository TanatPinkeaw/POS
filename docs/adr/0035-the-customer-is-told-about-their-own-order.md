# ADR 0035 — A customer is told about their own order, and the shop can see whether they were

**Status:** accepted (2026-10-19). **Amends ADR 0007** (the outbox and its planners) and
**implements the open half of ADR 0030 §3** (what a customer may be told on their own LINE).

**Context.** The owner asked a plain question: does LINE tell a customer when their product is
ready, and can it tell them anything else? Reading the code to answer it produced a worse
answer than "yes".

It does — one message, planned by `planLineCustomerReadyMessage` when a cashier packs an order.
But the message is gated on `NOTIFY_CHANNEL === 'line'`, while `NOTIFY_LINE_TOKEN` is the value
that looks like the switch (it is what campaigns use). A shop with a token, a bound and
consented customer, and a friendship on LINE could therefore send nothing at all, with no
error: the planner returns `null`, the outbox never hears about the order, and **no screen in
this system could show the difference between "not told" and "nothing to tell"**. The one tool
that reported on this — `npm run line:wizard -- --verify` — printed
`✓ webhook + push ลูกค้า: พร้อม` from a channel secret and a token, never reading
`NOTIFY_CHANNEL` at all.

Three more things were missing in the same direction. A customer was never told their order
was *accepted*; never told it was *cancelled* (the shop could release the stock, and the
customer's only signal was that the parcel never existed); and never reminded before the hold
ended, so a paid-for bag could sit on a shelf past its deadline in silence. The receipt exists
as a signed link (ADR 0021) and as a shareable picture (ADR 0034), but nothing pushed it.

## Decisions

### 1. Five customer messages, each its own kind

`order_ready`, `order_confirmed`, `order_cancelled`, `order_reminder`, `order_receipt` — all
LINE only, all to the customer's own subject, all planned by a pure function in
`line-notify.ts`, all written by `queueLineNoticeForCustomer` inside the transaction that
caused them.

**The reminder must be its own kind, and this is the reason the set is not one
`order_updated`.** The outbox dedupes on `(kind, order_id)`. Reusing `order_ready` for the
reminder would make it a duplicate of the ready message and it would never be sent — silently,
because `enqueueNotification` reports a duplicate rather than raising. The same constraint is
what makes each message a single fact per order, so none of them needs a `dedupeKey`.

### 2. A blocked message is still not queued — the answer is visibility, not rows

ADR 0007's rule stands: an undeliverable message must not become a row a worker retries
forever. So every planner returns `null` on a missing condition, and the fix for "nobody can
see it" is not an audit row per blocked message (some of these doors are reachable without a
session, and a row per refusal is a free way to fill the trail — the same reasoning as the
rate limiter's first-refusal-only rule). The fix is two readers of one pure module:

- `src/lib/line-readiness.ts` — `lineReadiness(env)` names five doors and, for each, whether
  it is `ready`, `blocked` (**some** of its values set) or `off` (**none**). The distinction
  is the whole point: a shop that never configured LINE is fine; a shop that set the token and
  not the channel believes it is sending and is not.
- The same module is rendered by `/admin/line` (from `process.env`, i.e. what the server is
  actually using) and printed by `npm run line:wizard -- --verify` (from `.env` on disk). The
  two disagreeing is information: it means somebody edited the file and did not restart.

### 3. The counter is told what the planner decided

The pre-order board now carries one line per waiting parcel: `แจ้งเตือนลูกค้าแล้ว`,
`อยู่ในคิว`, or the reason it did not go — `ยังไม่ได้เพิ่มเพื่อนร้าน`, `ยังไม่ผูกบัญชี LINE`,
`ยังไม่ยินยอมรับแจ้งเตือน`, `ร้านยังไม่ได้ตั้งช่องทางแจ้งเตือน`. The decision is
`customerNoticeOutcome`, which reads the notification row first (a row is the record) and only
re-derives from `lineCustomerNotifyBlock` when there is none. The cashier's question — "will
this customer know to come?" — is answerable without the customer telling them.

### 4. A queue nobody drains is a third failure, and the only fix is a clock

Delivery fails in three ways, and only two were visible: a message that LINE refused
(`abandoned`), a message successfully sent, and a message **no worker ever claimed**. The
third leaves every row `pending` forever, so the dashboard's existing "ส่งไม่ออก" card never
appears — there is no gateway left to refuse anything. `outboxStalled` reports it from two
numbers that already existed (how many are due, and how old the oldest due row is), with a
ten-minute grace against a worker that passes every thirty seconds. No heartbeat table: the
queue itself is the heartbeat.

### 5. The receipt link rides the message, and its expiry is in the sentence

`completeOrder` mints a link with `createReceiptLink`'s own rule — `RECEIPT_LINK_TTL_MINUTES`
(60 by default), never past the one-month access window — and the message says
`ลิงก์ใช้ได้ถึง HH:MM น.`, plus where to reopen it afterwards. A link that dies in an hour is
only usable if the message says so, and the receipt stays available from the orders screen for
the whole window (ADR 0034).

No link is minted without `PUBLIC_BASE_URL`: `public-url.ts` records that a route handler
cannot derive its own address, and a receipt link naming `localhost` sends the customer to
their own phone.

### 6. The consent already covers this, and bumping its version does not re-ask

`line_consent_at` is "tell me about my own order" — every one of the five messages is a fact
about exactly that order, so the existing consent is the right one and the promotion consent
stays separate (ADR 0032 §5). The account card's wording is widened to say so and
`LINE_CONSENT_VERSION` is bumped, but the gate reads `line_consent_at` **only**, so no customer
is silently cut off by a version change and none is re-asked. A shop that wants to re-consent
everyone has to build that; this ADR deliberately does not.

## Alternatives rejected

- **One `order_updated` kind.** Collides with the ready message under `(kind, order_id)` and
  makes "which message did this customer get" unanswerable from the row.
- **Queue a row for a blocked message so the shop can see it.** An outbox of undeliverable
  rows is a to-do list that never shortens (ADR 0007), and the readiness panel answers the
  question without writing anything.
- **Send the four new messages on `webhook` (SMS) too.** It doubles the surface and changes
  what the acceptance journey earns on its own channel; a webhook shop keeps today's
  behaviour. Recorded as a gap, not as a design.
- **A worker heartbeat table.** A second thing to keep in step, when the queue already carries
  the timestamp that answers the question.
- **Send the receipt message without the link, pointing at the orders screen.** Rejected
  because the customer asked for the receipt at the counter; the exposure is bounded (one
  order, one hour, the person who paid).

## Consequences and knowingly-left gaps

- Only `order_ready` reaches a `webhook` shop's customer, by SMS. The other four are LINE-only.
- The reminder depends on `pos-notify.service` running; a stopped worker means no reminder —
  which decision 4 now makes visible, but does not fix.
- A reminder that is queued and then fails counts as sent by the sweep (`notifications: none`
  excludes it). A retryable failure would need the sweep to consider `abandoned` rows too.
- `npm run acceptance` does not exercise the four new kinds: its journey runs on
  `NOTIFY_CHANNEL=webhook` with no LINE-bound member, so the planner correctly queues nothing.
  The kinds assertion in `scripts/acceptance.ts` is unchanged for that reason, not because
  nobody looked.
- The rich menu, scheduled campaigns, Flex templates and the in-app reply box remain
  deliberately unbuilt (ADR 0033, ADR 0032).
