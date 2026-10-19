# Customer notices — one question, five messages, and a way to see the answer

## The question this started from

"Does LINE tell a customer when their product is ready, and can I tell them anything else?"

The honest answer before this work was: one message, on a condition nobody checked, with no
screen anywhere able to say whether it had been sent. `NOTIFY_CHANNEL === 'line'` gates the
customer's ready message while `NOTIFY_LINE_TOKEN` is the value that looks like the switch, so
a configured-looking shop could send nothing — and the wizard agreed with the shop, because it
printed "push ลูกค้า: พร้อม" from the token and a secret without reading the channel at all.

## What this builds

**Phase 1 — the shop can see the answer.**

1. `src/lib/line-readiness.ts` — five doors, three states (`ready` / `blocked` / `off`),
   pure; plus `outboxStalled`.
2. `npm run line:wizard -- --verify` prints those doors instead of its own guess.
3. `/admin/line` renders the same doors from the running process, plus the count of customers
   who can actually be reached today.
4. The dashboard reports a queue nobody is draining, which is the failure that leaves no trace.
5. The pre-order board says, per waiting parcel, whether the customer was told and — if not —
   why.

**Phase 2 — four more facts about the customer's own order.**

`order_confirmed`, `order_cancelled` (staff cancel and automatic expiry), `order_reminder`
(once, before the hold ends) and `order_receipt` (a link whose expiry is stated), all on the
customer's own LINE, all inside the transaction that made them true.

## Decisions that shape everything

- **A blocked message is still not queued.** ADR 0007's rule; the cure for invisibility is a
  reader, not an audit row per refusal.
- **Each message is its own kind,** because the outbox dedupes on `(kind, order_id)` — reusing
  `order_ready` for the reminder would silently never send.
- **The reminder is derived, not scheduled.** It comes from `pickup_expires_at` and runs in
  the notify worker's pass; it is not ADR 0032's campaign scheduling.
- **The receipt link states its own death.** 60 minutes by default, never past the one-month
  window; a dead link with no explanation is worse than no link.

## What this does not build

SMS for the four new messages (a webhook shop keeps only the ready note), Flex templates,
scheduled campaigns, an in-app reply box, or a re-consent flow. All recorded in ADR 0035.

## Proof

- `tests/line-readiness.test.ts` — the four states a shop is actually in, and the stall
  boundary.
- `tests/line-wizard.test.ts` — the report comes from the shared module; the old sentence is
  gone.
- `tests/line-notify.test.ts` — each planner's sentence, each refusal, and the counter's
  read-back.
- `tests/customer-notices.test.ts` — the wiring against real Postgres: accepted, ready and
  receipt on one journey; a staff cancellation tells and a member's own does not; the expiry
  tells; the reminder queues once and never twice; and a webhook shop gets the SMS ready note
  and none of the LINE-only four.
- `npm run verify` — typecheck, `ui:audit`, `doc:audit`, palette, unit + integration.
- `npm run route:audit` — `/admin/line` renders only classes its CSS defines.
