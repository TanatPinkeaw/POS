# ADR 0019 — The till sells offline, and the sync owes the books

**Status:** accepted (2026-09-29). The specification is `docs/offline-till-spec.md`; this
ADR owns *why* it is shaped that way and what it knowingly gives up.

Phases 1 and 2 of the five are built — the pure decision modules, and the numbering
protocol: `number_blocks`, the freeze inside the allocating statement, and the borrow /
report / cancel endpoints. So is everything in phase 3 that is not a screen: **the sale
endpoint now carries and judges the numbers a device printed** (`deviceNumbers` on the
walk-in sale, `claimNumberFromBlock` against the open block), the **till store**
(`till-store.ts`) holds the local-vs-server decision, the **device's own storage**
(`offline-db.ts`, IndexedDB) sits under it, and an offline bill is **priced on the device
by the same `vat.ts`/`money.ts` the online sale uses**. The shop's reserve is real too
(`products.offline_safety_qty`, with the column's CHECK refusing a negative one and a
field at `/admin/products` to set it), so decision 3's safety quantity is the shop's own
number rather than a hardcoded zero. The till is **wired through the store**: every sale is
a server call or a device call, a device sale queues on the device and prints its own
numbers, and the till says what it is (`offlineNotice`). What is not built: the replay.
Nothing borrows, and a shop still cannot sell offline.

**Context.** Every sale in this system needs the network. The catalogue is paged in, the
member is looked up, the payment intent is opened, the sale is written, and — the part that
makes offline hard — the **call number and the receipt number are allocated on the server
inside that same transaction**. When the shop's connection drops, the till does nothing at
all. `CONTEXT.md` item 4 had already decided that this failure must at least *speak*; this is
the decision that it should also not happen.

Three interviews produced it, and each answer moved the design:

- The shop's box is a **VPS we rent** on a domain we already own (hosting, not self-install),
  so an outage of the shop's own line is a first-class case rather than a hypothetical.
- A shop with no printer must still hand its customer something, so offline bills have to be
  as complete as online ones on the customer's side.
- The owner chose **offline selling with a later sync** over the two cheaper answers
  (below), knowing that it is the largest single piece of work in this repository's future.

### Decision

1. **A cash sale may be closed with no connection.** The device holds the catalogue, the
   shop's tax settings, the open shift and a block of numbers; it takes the next number off
   its own block and queues the bill for replay. Everything that cannot be honest offline is
   refused in Thai with a next step: member lookup, points, pre-orders, refunds and voids,
   PromptPay, a discount past the shop's limit (the supervisor PIN is verified server-side),
   and a tax invoice once the block is spent.

   Rejected: **offline for everything.** It would put the customer table on a tablet nobody
   controls — the privacy decision of `CONTEXT.md` item 9, restated for a device that sits in
   a shop — and PromptPay cannot work offline at all, because the bank is the only party who
   can say the money arrived.

2. **Numbers are lent in blocks, not invented.** While online, the device reserves a range
   for the receipt series (a VAT shop) and the call numbers for today and tomorrow; the server
   **freezes that series** until the device reports how far it counted, and then continues
   from the last number actually printed. That is what keeps the series gapless with the
   allocation happening in a browser: no number can be issued inside a reserved range, and no
   reserved number is skipped.

   The half of this that reads as a contradiction until it is said out loud: **a device that
   holds numbers is the allocator for its own bills, online sales included.** A block starts
   at `counter + 1`, so while it is open the server has nothing of its own to hand out — and
   if it issued one anyway, the device's later report would be setting the counter back
   *below a number already issued*, which nothing can undo. The freeze and that sentence are
   one fact seen from two sides. A shop with nothing borrowed keeps today's behaviour (the
   server allocates), which is why implementing the freeze did not change a single existing
   sale.

   Rejected: **no tax invoice offline** — a VAT shop handing a customer a document that is
   not the one the law asks for at the point of sale. Rejected: **VAT shops lose the offline
   path** by looking at `shops.is_vat_registered` — a trap, because a shop that registers for
   VAT later would silently stop being able to trade offline, and nothing would tell it.

3. **The stock promise offline is weaker, and it is written down as an inequality.** Online,
   "never oversell" is one conditional `UPDATE`. Offline, the device sells from a snapshot
   and the shop sets a **safety quantity** it may not sell through (default 0). A sync that
   finds the shelf shorter than the device believed **accepts the bill** — the goods are in
   the customer's hands — lets stock go negative and raises a correction task.

   Rejected: **refuse the bill at sync.** A record that contradicts the customer's receipt,
   and a shop arguing about money it has already taken.

4. **A bill belongs to the day it was sold, not the day it was synced.** `orders.sold_at` is
   added, non-null, and every day-bucketed read moves onto it. A 21:00 sale synced at 08:12
   lands on yesterday's takings, because a daily reconciliation that moves money between days
   is a reconciliation nobody can close.

5. **Replay is one endpoint and one identity.** The device posts the queued bills with a
   `client_ref` it generated; a unique index makes a retry, a timeout and a duplicate request
   write **one** order. Same shape as `credit_notes (order_id, sequence)`: the API checks, the
   database is what makes it true.

6. **The customer display goes quiet, and that is stated rather than designed away.** It is a
   second browser reaching the same server, so with no connection there is nothing to tell it.
   The till's own board still shows what it has not sent, which is what lets the bar make the
   drink.

### What this costs, in the repository's own terms

Five invariants move out of PostgreSQL and into the browser, and each one has to be
re-established by hand:

| Was enforced by | Becomes |
| --- | --- |
| `sellFromStock`'s conditional `UPDATE` | a snapshot check in a pure module, plus the shop's safety quantity |
| The shop row's counters, bumped inside the sale's transaction | a reservation row, a freeze, and a report the device has to make |
| `UNIQUE (queue_day, queue_number)` | a block per day, and a device clock that could still name the wrong day |
| `cash_shifts` and one open shift | a shift snapshot on the device |
| `audit_logs` that refuses UPDATE and DELETE, and a PIN verified server-side | nothing equivalent — which is why refunds, voids and over-limit discounts are refused offline |

The protocol in decision 2 is the one that pays for itself twice: it is *also* what makes the
series correct if a shop ever runs a second register, because the freeze refuses a number
that would land inside a held range rather than issuing one out of order.

### Gaps this knowingly leaves open

- **A device must not borrow yet, for a new reason.** The sale path *does* accept a
  device's own number now, so a block can be issued from online. What is missing is the
  other direction: a bill closed offline sits in the device's queue with no way to reach the
  shop until the replay exists, and `mayUseServer` then keeps that device off the server for
  selling at all (a number printed but unsent is a hole in the series the moment anything
  takes a number after it). So a shop that borrowed today could sell offline once and then
  be unable to sell online until phase 4's sync lands. Borrowing is wired with the replay,
  not before it.
- **The offline till's screens have no automated test either.** `route:audit` proves every
  screen renders styled, and nothing proves a *behaviour*: no test in this repository has ever
  loaded a browser. So the notice, the queue count and an offline sale are verified by reading
  the code and by a human walking through an outage — the same standing gap the README records.
- **The device adapter has no automated test.** The suite runs in a Node environment and the
  repository refuses the dependency that would fake IndexedDB, so the decisions all live in
  pure modules and the adapter is kept decision-free. The *seam above it* is tested
  (`tests/till-store.test.ts`) because the store takes its storage as a port; what is
  untested is the file that opens a database and reads a record. `route:audit` plus a human
  walking through an outage is the whole proof for that layer.
- **The reserve protects a device from itself and nothing else.** `offline_safety_qty` is
  read into the device's catalogue snapshot and consulted only by `offlineSellableQty`; the
  server's own oversell guard never looks at it, so a reserve does not hold stock back from
  an online sale, a pre-order or another till. That is the right scope for a rule about what
  a *disconnected* device may promise, and it means a shop that wants stock kept back
  altogether cannot express it with this number.
- **A device whose clock is wrong names the wrong day.** The call-number block carries the
  day it is for, so the damage is bounded to the day the sale is filed under, and the sync
  flags the disagreement — it is not corrected.
- **A block that runs out stops tax invoices.** The till may sell no VAT bill until it is
  online again; the shop's only lever is a larger block, and the runbook has to say so in
  plain Thai.
- **An offline bill is recorded at the device's price, and phase 4 has to keep it.** The
  queue carries `unitPrice` per line, because the customer paid those figures and re-pricing
  the bill from a catalogue that moved on would be money disagreeing with a slip. The
  replay's endpoint therefore has to accept a device-supplied price, with the catalogue's
  own price logged beside it — that is the owner's "what the till sold at" (user story 29),
  and it is a write path that does not exist yet.
- **Two full days offline ends call numbers.** Bills keep being sold and are flagged as ones
  that got no number — an unfiled ticket, not an error state.
- **The customer display is stale for the duration of the outage.**
- **No shop has run any of this.** Like everything else here, "green" means correct as far as
  the tests reach, and no test in this repository has ever loaded a browser.
