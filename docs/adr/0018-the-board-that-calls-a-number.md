# ADR 0018 — The board that calls a number, and the state beside the order's status

**Status:** accepted (2026-09-29). This is round 2 of ADR 0017: that ADR gave every
walk-in bill a call number and printed it on the slip; this is what shows the number to a
room and what a shop taps to move it along.

**Context:** ADR 0017 left the number doing nothing but sitting on paper. Two questions the
system still could not answer: which numbers are on the bar right now, and which are ready
to be called. The reason it could not answer either is one line of `createPosSale` — a
walk-in sale is paid and `status = 'completed'` in the same instant, so nothing
distinguishes *the money is settled* from *the drink has been handed over*. The shop's work
continues for minutes after the shop's books are closed for that bill, and for drinks that
is the whole point.

**Decision.** The goods get their own state machine, beside the order's status rather than
inside it:

```
preparing ──mark_ready──> ready ──collect──> collected
     │                     │
     └──────── collect ────┘
```

1. **`fulfilment_state` is a second machine, and `order_status` is not touched.** Rejected:
   a sixth `order_status` value such as `making`. `completed` is what every sales report,
   every refund and the drawer reconciliation count, and a drink waiting to be made is not
   a different kind of money — adding a status would turn "how much did we sell today" into
   a question about the bar's queue, and would put the money machine's `canTransition`
   table in the position of refusing a refund for a reason that has nothing to do with
   money. The two machines are separate files with separate tests, and the pure one is
   `src/lib/fulfilment-state.ts`.
2. **A ticket is minted inside the sale's own transaction.** `createPosSale` writes
   `preparing` where it already writes the call number, so a ticket cannot exist for a bill
   that was not settled, and a rolled-back sale leaves no ticket behind. Null means "no
   goods waiting": a pre-order, whose handover *is* its payment (ADR 0017 decision 5), and
   every bill written before this machine existed.
3. **Staff advance it, one tap each way.** `POST /api/v1/orders/[id]/fulfilment` with
   `mark_ready` or `collect`, behind `requireRole(['employee', 'admin'])` — employees too,
   because the person making the drink is at the counter and a screen only an owner can
   open is a screen a small shop never uses. One route for both moves, unlike the pre-order
   phases, which are a route each because each of them mints something; splitting these two
   would mean two copies of the board refresh, and the copy somebody forgets is the one
   that leaves a stale board in front of customers.
4. **`preparing → collected` is legal.** A shop hands the cup over without tapping the
   middle button on most busy afternoons. Refusing that move would leave the bill on a
   customer-facing board for the rest of the day, which is worse than a missing timestamp.
   `collected` is terminal.
5. **The board is today's board.** A ticket is on it while `queue_day` is the current
   Bangkok day (ADR 0017 decision 4) *and* the order is still `completed`. Two consequences
   fall out of that for free, and both are the reason the rule is written this way: a
   **refunded bill drops off the board with no tap and nothing to remember**, because
   `refunded` is a status the board already filters; and a ticket nobody ever tapped
   **leaves at midnight** instead of accumulating in front of customers forever.
6. **Two screens read the same rule, differently — on purpose.** The bar's screen
   (`/pos/queue`) re-reads the board from the API, on mount and on a bare `queue:updated`
   nudge, and never draws itself from the event payload: two tablets must show one board,
   and the one that was asleep when an event fired still has to be right when it wakes. The
   customer display holds no session and cannot re-read anything, so it is *sent* the board
   itself, rebuilt from the table by the same `buildReadyPayload` that already fed its
   pre-order list. **Only `ready` numbers reach the display**: a call board showing numbers
   nobody is calling teaches customers to stop reading it — the same argument ADR 0006
   makes about what that screen must not carry.
7. **`ready_at` is shared with the pre-order path.** A walk-in drink made and a pre-order
   packed are the same fact — the goods are on the shelf and waiting — so they write the
   same column, and a waiting-time report would not have to ask which kind of order it was
   reading. No third timestamp was added for this machine: `completed_at` starts the clock
   and `ready_at` is what the board counts from.

**Consequences and gaps.**

- **The numbers are only unique within today** by design (ADR 0017), which is exactly why
  the board is scoped to today rather than to "everything not yet collected".
- **A screen left open across midnight keeps showing yesterday's remaining tickets until
  something happens or somebody reloads it.** The next realtime event or a refresh fixes it;
  nothing sweeps the screen on a clock. Stated rather than hidden because the failure is
  visible to customers.
- **Nothing measures waiting times yet.** `completed_at` and `ready_at` are both now written
  on the walk-in path, so the data exists, and no report reads it.
- **No audit row per tap.** Moving a ticket is routine work, not authority, and a row per
  tap would drown the events an owner actually needs to find — the same argument ADR 0009
  makes for recording only the first refusal of a burst.
- **Two tablets at one bar both work**, because the board is the table rather than either
  screen's memory; the second tap on a ticket is refused by the state machine and reported
  rather than silently dropped.
- **Measured:** `tests/fulfilment.test.ts` — the pure transitions, a sale landing on the
  board as `preparing`, the tap to `ready`, the tap off the board, the refused second tap,
  a refunded bill refused, a collected pre-order having no ticket at all, and yesterday
  being absent from today's board. `route:audit` now walks **eighteen** screens, the new one
  included.
