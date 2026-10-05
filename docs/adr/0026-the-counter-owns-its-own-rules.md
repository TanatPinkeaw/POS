# ADR 0026 — The counter owns its own rules: a staff pre-order cancel is audited, not approved

**Status:** accepted (2026-10-05)
**Context:** A shop uses this system every day and the feedback from a week of real use
came back in eleven items. Four of them were one bug wearing different clothes, and two
of those four are decided here.

**The cancellation that could not happen.** `POST /api/v1/orders/{id}/cancel` called
`requireApproval(request, 'void_order', id)` for anybody who was not a member. So an
employee could not cancel a pre-order at all: not their own, not one they had entered
by mistake thirty seconds earlier, not one whose customer had called to withdraw it.
They got a bare 403 and no way forward — and, worse, the PIN prompt that would have
answered it was never wired into the pre-order board, so the rule was not merely strict,
it was unsatisfiable from the screen.

**The countdown that disagreed with the sweeper.** The board carried its own
`CONFIRM_TIMEOUT_MINUTES = 15` and counted down from `created_at`, while the server
swept on `created_at + PREORDER_CONFIRM_TIMEOUT_MINUTES`. Two evaluations of one rule.
Change the shop's setting and the orders already in the queue were silently re-dated —
raised settings gave them time nobody promised them, lowered settings cancelled them out
from under a customer who had been told how long they had.

**Why these were found together.** Both are the same mistake: a rule that had been
copied into a second place instead of being asked for once. The approval gate and the
countdown each had an owner (the route, the server) and a copy (the other one), and
both copies were the ones being wrong.

## Decisions

### 1. Staff cancel a pre-order without a supervisor, and the trail records it anyway

`cancelOrder` takes `staffVoid` and no longer takes `authorizedByUserId`. The route
stamps `staffVoid: session.role !== 'member'` and drops `requireApproval` entirely. The
member rule is unchanged: a member may cancel their own order and nobody else's.

The reason the gate is the wrong instrument is not that it is inconvenient. It is that
the thing being gated is not the thing the gate was built for. `void_order` exists on the
walk-in till because that button reverses **money that has already changed hands**, the
person pressing it did not take it in, and the difference between a cashier who can void
freely and one who cannot is the difference between a shortage being noticed in a week
and in a year. A pre-order that has not been confirmed yet holds nothing but a
reservation. Releasing a reservation is a shelf decision — the goods are still on the
shelf and go back into the sellable count — and the person who can see the shelf is the
person who should be able to say so.

What replaces the gate is **record-keeping, not permission**. Every staff cancellation
writes a `void_order` row naming the employee as the actor, with no approver and
`detail.approval = 'not_required'`. This is load-bearing rather than decorative: the
original reason the audit trail mattered was "who released this reservation and why",
and that question does not change just because the answer no longer needs a second name
on it. A counter where any employee can cancel anything is *fine*; a counter where any
employee can cancel anything and nobody can find out afterwards is not.

### 2. The Phase 1 deadline is stamped on the order

New nullable column `orders.confirm_deadline`, written by `placePreOrder` from the
same clock read that stamps `created_at`. The sweeper expires on
`confirm_deadline < now()`, with `confirm_deadline IS NULL AND created_at < cutoff` as
a fallback for rows that predate the column and nothing else. `OrderListView` carries
it, so the board counts down to a value the server holds rather than to a constant
compiled into the browser.

Nullable is the normal state, not a gap: a walk-in sale has no Phase 1 and a
`completed` pre-order has passed its own.

The migration backfills pending pre-orders at the **old** fifteen-minute default, not
the new one. Re-deriving them under thirty would retroactively extend the deadline of an
order a customer may already have watched expire.

### 3. The default timeout becomes thirty minutes

`PREORDER_CONFIRM_TIMEOUT_MINUTES` defaults to 30. Fifteen is a number chosen for a shop
whose customer is standing at the counter; this shop's pre-orders arrive from a phone,
and by the time the customer has decided to buy, the order they left pending has expired
and released its stock, so they return to an order that no longer exists and a cashier
who has to explain it. It stays env-overridable, and per decision 2 changing it now only
affects orders placed afterwards.

**The migration adds no index.** The sweeper's predicate is
`status = 'pending' AND order_type = 'preorder' AND confirm_deadline < now`, and the
existing `(order_type, status)` index already narrows it to the handful of unconfirmed
orders on the shelf. A partial index would be marginally better and completely invisible
to Prisma, which cannot model one — so the next `migrate dev` would find a database
object the schema does not describe and offer to drop it.

## What this does not change

- **Refunds still need a supervisor.** `refund` reverses a completed sale, the money
  has moved, and it still calls `requireApproval`. The line is cancellation-versus-refund
  and it has not moved.
- **The till's void button still needs a supervisor.** Same reason, and same button.
- **A member cancelling their own pre-order is still not audited**, because a customer
  withdrawing their own basket is not an event the shop has to account for and logging
  every one would bury the ones that are.