# 06: Accepted, and cancelled — the two facts a customer was never told

**What to build:** `order_confirmed` when staff accept a pre-order, and `order_cancelled` when
the shop cancels one — by hand or by the expiry sweeper.

**Blocked by:** 01, 05 (the shared helper and the reason vocabulary).
**Status:** done

- [x] `planLineCustomerConfirmedMessage` — order number, item count, new total, and the dropped
      lines when partial confirmation removed some. A customer who ordered three must not learn
      about two by arriving.
- [x] `planLineCustomerCancelledMessage` — the shop's own reason; **conditional** money
      sentence ("ถ้าโอนเงินมาแล้ว"), because a pre-order is usually unpaid and an unconditional
      refund promise is a lie the counter has to explain.
- [x] `queueLineNoticeForCustomer` — one helper, four conditions, no second copy of the rule.
      The order of checks is the cost model: channel and subject are free, the friend row is a
      query, the planner is pure.
- [x] `confirmOrder` counts removed lines, returns the customer from the same `UPDATE … SELECT`
      join, and queues inside the transaction.
- [x] `cancelOrder` queues **only when `staffVoid`** — a member withdrawing their own order is
      the actor, not the audience. The same flag already decides whether the void is audited.
- [x] `expireStalePendingOrders` queues its own wording (`หมดเวลายืนยันภายใน N นาที`): an order
      that vanishes because nobody confirmed it is the same defect, and this is the path where
      no human is at a screen to remember to call.
- [x] Both are one fact per order because each is its own kind — the outbox's `(kind, order_id)`
      does the rest.

## Notes

`order_confirmed` and `order_cancelled` are **not** sent on the `webhook` channel. That is a
recorded gap in ADR 0035, not an oversight: the acceptance journey runs on webhook and would
otherwise earn two more kinds, and expanding SMS is a different decision from this one.
