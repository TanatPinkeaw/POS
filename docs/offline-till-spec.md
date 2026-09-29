# Selling when the network is gone — spec

**What this file is.** The specification for the one remaining piece of the till that
assumes a working network: taking money with no connection, and making the books
right when it comes back. It came out of an interview, so the decisions below are the
owner's and the reasoning behind them is in ADR 0019. The *vocabulary* is
`CONTEXT.md`; the *state of the build* is `README.md`.

**Phases 1 and 2 are built; nothing else is.** The three pure decision modules exist with
their tests (`number-block.ts`, `offline-sale-rules.ts`, `sync-plan.ts`), and so does the
numbering protocol on the server — `number_blocks`, the freeze inside the allocating
`UPDATE`, and the borrow / report / cancel endpoints. The device store and the replay do
not exist, so a shop still cannot sell offline — and, until phase 3 lands, **a device must
not borrow either** (see *Who allocates while a block is out*).
Anything this document names as a later command is written **without** the `npm run`
prefix on purpose: `doc:audit` (ADR 0013) fails a document that runs a command which
does not exist, and that gate is right.

**The shape in one paragraph.** A shop's internet drops today and the till does
nothing — silently, mid-queue. This specification makes the till keep selling: it
holds the catalogue and a block of call numbers on the device, closes a **cash** sale
locally with a number out of that block, and replays it when the network returns,
reporting which numbers it used so the shop's series stays gapless. Everything the
database used to enforce for the till — never oversell, no gaps in a document series,
one drawer, an audit trail — moves into the browser, and each one has to be
re-established by hand. That price is the reason the three decisions below exist.

---

## Problem Statement

A shop's till needs the network for every sale. The catalogue is paged in from the
server, a member is looked up on the server, a payment intent is opened on the
server, the sale is written by the server, and the call number and the receipt number
are allocated by the server inside that write. When the shop's connection drops — a
4G hotspot, a domestic line, our own box being restarted — the till does nothing at
all: the basket cannot be closed, the drawer cannot take cash, and the customer in
front of the counter hears "the system is broken". The failure is silent and it looks
like a broken shop rather than like a lost network.

The offline refusal that was already chosen (a runtime check that names the failure)
makes that honest but does not make the shop able to trade. `CONTEXT.md` item 4
deliberately deferred the real answer until a shop lost money to an outage. This
specification is that answer.

## Solution

The till keeps working with no connection, for the part of a shop's day that does not
need the outside world:

- The **catalogue**, the **shop's tax settings**, the **open shift** and a block of
  **call numbers and receipt numbers** are held on the device, refreshed whenever
  there is a connection.
- A cash sale is closed on the device: it takes the next number out of its block,
  writes the bill into a local queue, prints its slip (or draws it), and shows on the
  till's own board so the bar can make it.
- When the connection returns, the device **replays** the queue in order, reports how
  far it counted, and gets back a result per bill. The server then continues the
  shop's series from the last number actually used — so the series has no gap, even
  though the numbers were handed out by a browser.
- What cannot be honest offline is refused, in Thai, with what to do next: a **member**
  lookup, **points**, a **pre-order**, a **refund or void**, a **PromptPay** payment,
  a **discount past the shop's limit** (the supervisor PIN is verified on the server),
  and — when its block runs out — a **tax invoice**.

The consequence to state plainly: this is not "the same shop, offline". It is a
smaller shop, offline, and the sync is what makes it whole again.

---

## User Stories

**The cashier, during an outage**

1. As a cashier, I want the till to keep working when the internet drops, so that the
   queue in front of me does not become a queue of people walking out.
2. As a cashier, I want to be told clearly that the till is offline and what still
   works, so that I stop reaching for buttons that will fail.
3. As a cashier, I want to sell from the catalogue already on the screen, so that I
   do not have to remember prices.
4. As a cashier, I want to search and scan products with no connection, so that the
   normal way I find an item keeps working.
5. As a cashier, I want the till to tell me what the price is offline, taken from the
   same catalogue the shop publishes, so that I never quote a price the shop does not
   sell at.
6. As a cashier, I want to take cash and hand back change with no connection, so that
   the sale is finished at the counter.
7. As a cashier, I want the tax and the VAT on that slip to be the shop's real tax
   settings, so that the slip I hand over is not an approximation.
8. As a cashier, I want a call number on that slip, so that the customer can be called
   when the drink is made, exactly as when we are online.
9. As a cashier, I want that number to come from the shop's own series rather than
   from the device's memory, so that two tickets never share a number.
10. As a cashier, I want a discount within the shop's normal limit to still work, so
    that the everyday case does not need a network.
11. As a cashier, I want to be refused — with a reason and a next step — when a
    discount needs a supervisor's approval, so that I do not promise a customer
    something I cannot deliver.
12. As a cashier, I want to be refused, clearly, when the customer wants to pay by
    PromptPay, so that I offer cash instead of a QR that will never confirm.
13. As a cashier, I want to be refused when I look up a member, so that I do not
    invent a customer that the shop cannot see.
14. As a cashier, I want to be refused when I try to refund or void, so that no money
    leaves without the document that is supposed to accompany it.
15. As a cashier, I want to see how many bills are waiting to be sent, so that I know
    the till has not lost anything.
16. As a cashier, I want to press a button to send them the moment the network is
    back, so that I am not waiting on a timer I cannot see.
17. As a cashier, I want a slip for an offline sale to be printable or drawable, so
    that the customer leaves with the same thing they always leave with.
18. As a cashier, I want an offline sale to belong to the drawer I already have open,
    so that closing my shift reconciles the cash that is actually in the drawer.
19. As a cashier, I want an offline sale to appear on the till's board, so that the
    bar knows what to make while the network is down.
20. As a cashier, I want to be told when the device's block of numbers is running low,
    so that I can get the till online before it runs out.
21. As a cashier, I want the till to refuse a tax-invoice sale rather than invent a
    number, so that the shop never hands out a document whose number is wrong.

**The owner, looking at the books**

22. As the owner, I want the receipt series to have no gaps after a day of offline
    selling, so that the shop can answer the Revenue Department without a story.
23. As the owner, I want the call numbers to be unique per day, so that a customer is
    never called by a number that is doing duty for two drinks.
24. As the owner, I want yesterday's offline bills to appear on yesterday's takings,
    not on the day the network came back, so that the daily reconciliation is right.
25. As the owner, I want to know which bills were recorded with no connection, so that
    a difference between the slip and the record has an explanation.
26. As the owner, I want to be told when the sync found a product with less stock than
    the device believed, so that the shelf can be counted rather than argued about.
27. As the owner, I want the option to keep a safety quantity the till may not sell
    offline, so that the last two of something are not sold to a queue while somebody
    is on their way to collect a pre-order.
28. As the owner, I want a reserved block that was never reported to show up as a task,
    so that the series does not stay frozen without anybody knowing.
29. As the owner, I want to see, per bill, the prices the till sold at, so that a
    device sitting in a shop for months cannot quietly disagree with the catalogue.
30. As the owner, I want an offline sale to be visible in the audit trail for what it
    is, so that "recorded offline, synced at 08:12" is a fact and not a rumour.
31. As the owner, I want the cash drawer's expected figure to include offline cash, so
    that the count at close is not short by the amount we took while the network was
    down.

**The person running the box**

32. As the operator, I want the offline path to be exercised in the test suite against
    real Postgres, so that the money rules are checked without a browser.
33. As the operator, I want the series reservation to be enforced by the database, so
    that a second writer cannot slip a number into a reserved range.
34. As the operator, I want to know what this costs, in writing, so that "we support
    offline" is not heard as "the books are the same".

**Explicitly not a story**

35. As a customer, I want the customer display to keep updating during an outage — and
    it will not, because the display is a second browser that reaches the same server.
    This is a stated gap, not an oversight.

---

## Implementation Decisions

### One seam: the till store

The till's reads and writes go through a single client module — the **till store** —
whose job is to answer one question per operation: *is this a server call, or a
device call?* `useTill` and the queue board stop calling `apiFetch`/`apiPost`
directly and call the store instead. Everything above the store is unchanged; the
store is the highest place the offline/online decision can be made, and it is the
only new seam this work introduces.

Beneath it, the repository's existing rule holds without exception: **decisions are
pure modules, records are persistence modules.**

| Module | Kind | Owns |
| --- | --- | --- |
| `offline-sale-rules.ts` | pure | Whether a basket may be closed offline, and every refusal as a typed reason |
| `number-block.ts` | pure | Block arithmetic: what range a reservation is, what the next number is, what "used through N" means |
| `sync-plan.ts` | pure | What to replay, in what order, what counts as done, what a refusal means for the queue |
| `sale-instant.ts` | pure | Which day a bill belongs to, stated once (see below) |
| `offline-db.ts` | persistence (device) | The IndexedDB adapter — no decisions, only storage |
| `till-store.ts` | seam | Local vs server, refresh, queue, replay |
| `number-blocks.ts` | persistence (server) | Reserve, report, resolve; the database facts behind the pure module |

### The numbering protocol — how a browser can issue a gapless number

This is the heart of the work, and it exists because of what a tax invoice is:
numbers are issued in order, with no holes, and a hole is a question an auditor asks.

Today `allocateReceiptNumber` bumps the shop row's counter inside the sale's
transaction (ADR 0002). A browser cannot do that. So the shop **lends** the device a
range in advance:

1. **Reserve.** While the till has a connection, it asks for a block of the numbers it
   will need — for a VAT shop a block of the receipt series, and for every shop a
   block of call numbers for **today and tomorrow**. The server writes a row naming
   the range, advances the shop's counter past it, and hands the range back.
2. **Spend.** Offline, the till takes numbers off the front of its own block: the
   stored integer is always `last_used + 1`, and the printed form comes from the
   existing pure formatters (`queue-number.ts`, and the receipt formatter beside it).
3. **Freeze.** While any block is unreported, the server **refuses to allocate from
   that series** (a 409 naming the reservation). This is what keeps gaplessness true
   with a second writer: a number issued in the gap could not be ordered against the
   numbers the device is holding. Today nothing else advances these series — every
   sale in the shop comes from the one till — so the freeze costs nothing and buys the
   invariant. (For a walk-in sale the freeze is a 409; for a *call* number it means the
   bill goes through with no number, which the board and the sync both survive.)
4. **Report.** On sync the device says how far it counted, per series. The server sets
   the shop's counter to `last_used`, so the next online sale takes `last_used + 1`:
   **no gaps, even though the block's tail was never used.** A block that was never
   used at all is cancelled the same way, back to `from − 1`.
5. **Resolve.** A device that never comes back leaves an open block and a frozen
   series. That is a **task on the dashboard** — resolve it by naming the last number
   actually printed, or cancel the reservation — never a silent state.

#### Who allocates while a block is out

A device that holds numbers **is the allocator for its own bills, online sales included**,
and this reads as a contradiction until it is spelled out. A block starts at `counter + 1`,
so while it is open the server has no numbers of its own to hand out. If it allocated one
anyway — the next online sale taking `to + 1` — the device's later report would have to set
the counter back *below a number already issued*, and there is no way to put the series in
order again afterwards. So the freeze is not caution: it is the only arrangement in which
one gapless series can have two writers.

The consequences, in the order they matter:

- **A sale sent by a device that holds a block carries its own number**, and the server
  validates it (inside the open block, and not one the block has already used) instead of
  allocating. Phase 3 wires that, and until it does **a device must not borrow** — a block
  with no way to issue from it is a shop that cannot sell at all.
- **A shop with nothing borrowed behaves exactly as it does today**: the server allocates.
  That is the path a first day of trading, the smoke checks and the acceptance journey all
  rely on, and this specification deliberately leaves it alone.
- **The report is how a block is *closed*, not how the server learns what was printed.**
  The bills a device sends carry the numbers; the report gives back the unused tail and lets
  the series resume from the last number actually printed.

Two honest limits, both stated rather than designed away:

- A block can run out while the shop is offline. Then the till **refuses to close a
  tax-invoice bill** (Thai, naming the next step) rather than invent a number. A
  non-VAT shop has no receipt number to lose, so only its call numbers run out.
- Call numbers are per Bangkok day, so the device holds today's and tomorrow's. Two
  full days with no connection and the till stops calling numbers (it can still sell:
  the money is the money, and the sync flags the bill as one that got no number).

### What the device holds, and what it may not

Held, per shop, refreshed on every successful sync: the active catalogue with
`stock_qty − reserved_qty` as of that sync, the sale price, the barcode, the image
url; the shop's VAT settings (`is_vat_registered`, `vat_rate`, `prices_include_vat`,
`receipt_prefix`, footer); the supervisor discount limit; the open shift's id and
float; the number blocks and their usage; the queue of bills not yet sent.

**Not** held, by decision: the shop's customer list. Member lookup, points and
pre-orders are unavailable offline. This is the cheapest answer to the privacy
question in `CONTEXT.md` item 9 — customer data never leaves the server — and
PromptPay is unavailable offline for a reason that is not a choice at all: the bank is
the only party who can say the money arrived.

### The weakened promise, stated as an arithmetic rule

Online, "never oversell" is one conditional `UPDATE` (`src/lib/inventory.ts`). Offline
it cannot be, because the tally is a snapshot. So the shop sets a **safety quantity**
per product (default **0**, meaning no reserve), and the device may sell only while
`snapshot_available − sold_offline − safety > 0`. A sync that finds the real stock
shorter than the device believed **accepts the bill** — the goods are in the
customer's hands — lets stock go negative, and raises a correction task. The promise
offline is therefore "no oversell beyond the shop's own reserve", and that sentence
belongs in the runbook, not only in this file.

### Which day a bill belongs to

A bill sold at 21:00 offline and synced at 08:12 the next morning is **yesterday's
takings**. `orders.created_at` is the server's clock — the moment we learned about it —
so it cannot answer that. `orders.sold_at` is added (non-null; the server's now for
an ordinary sale, the device's instant for an offline one, backfilled to `created_at`
for existing rows) and **every day-bucketed read moves onto it**: the report range in
`reports.ts`, the dashboard's "today" in `analytics.ts`, the sales-by-day workbooks.
The rule lives in `sale-instant.ts` so a later report cannot quietly pick the wrong
column; `created_at` stays exactly as it is, as the separate fact that it is.

### Replay: one idempotent endpoint

The device posts its queue to one endpoint. The bill carries a **client reference**
(`orders.client_ref`, unique, a UUID the device generated) and the server treats it as
the identity of the bill: replaying the same bill twice — a retry after a timeout, a
duplicated request — writes **one** order. That index is the double-charge guard, in
the same spirit as `credit_notes (order_id, sequence)`: the API path checks, and the
database is what makes it true.

Refusals are typed, and every one of them must be a `DomainError` subclass — a stale
or refused replay that surfaces as a 500 is a cashier reading "something went wrong on
our side" (the trap `AGENTS.md` records about `InvalidPickupTokenError`). A refused
bill stays in the local queue with its reason shown, and the rest of the queue
continues.

### Schema

- `number_blocks` — one row per reservation: kind (`receipt` | `queue`), the day
  (queue only, and what a call-number block is *for*), `from_number`, `to_number`,
  `last_used_number`, a device label, who opened it, when it was reported or
  cancelled. A partial-open state is "`reported_at IS NULL AND cancelled_at IS NULL`".
- `orders.client_ref` — `String? @unique`, the replay's identity.
- `orders.sold_at` — `DateTime`, non-null, the instant the sale happened for the
  books (see above).
- `products.offline_safety_qty` — `Int @default(0)`, the reserve the till may not
  sell through while offline.
- No new column on `shops`: the shop row's counters keep meaning what they mean, and
  "is a series frozen" is answered by the block rows.

### API

All handlers through `withApi`, all of them authenticated (`employee` or `admin` from
the signed session, never from the body):

- Reserve blocks, report usage, and read back what the device should be holding.
- One sync endpoint that takes the reported usage **and** the queued bills together,
  so a device and its numbers move in one transaction, and returns a per-bill result.

### Surfaces

- **The till** owns the offline state: a plain statement that it is offline and what
  still works, the count of bills waiting, a "send now" action, a low-numbers warning,
  and the result of the last replay.
- **The till's board** shows the bills that have not been sent, so the bar can make
  them.
- **The dashboard** gains the two tasks this work creates: a reservation nobody
  reported, and negative stock the replay produced.

---

## Testing Decisions

**What a good test is here.** Only external behaviour: *given* a device holding a
catalogue and a block, *when* a cash sale is closed, *then* the next number is spent
and the bill is queued — never that a particular function was called. The money rules
are checked without a browser and without a server, the same way `refund-plan.ts` and
`fulfilment-state.ts` are.

**Where each level is tested, and the prior art to copy:**

| Level | Tested | Prior art |
| --- | --- | --- |
| Pure | `offline-sale-rules.ts`, `number-block.ts`, `sync-plan.ts`, `sale-instant.ts` | `refund-plan.test.ts`, `queue-number.test.ts`, `fulfilment.test.ts` |
| Server, real Postgres | The freeze while a block is open; reserve → spend → report leaving **no gap**; cancelling an unused block; the same `client_ref` twice writing one order; negative stock accepted with a task | `inventory-concurrency.test.ts`, `credit-notes.test.ts`, `shop-vat.test.ts` |
| The journey | A shop that sells offline and syncs — driven through the modules and the HTTP API the way `acceptance` already drives the renter journey | `scripts/acceptance.ts` |

**The gap that stays open, in writing.** `offline-db.ts` (IndexedDB) and the till's
offline screens have **no automated test**: the suite runs in a Node environment, and
the repository refuses the dependency that would fake IndexedDB (rule 2). So the
adapter is kept decision-free on purpose — every rule lives in the pure modules — and
its correctness rests on `route:audit` (every rendered class is defined in the CSS the
page loads) plus a human walking through an outage. `README.md`'s "not yet proven"
list gains this line.

## Out of Scope

- **Offline PromptPay, members, points, pre-orders** — decided against, not postponed.
- **Offline refunds, voids and credit notes.** A refund needs a document series, a
  PIN and the server's arithmetic; none of that can be invented on a tablet.
- **The customer display during an outage.** It is a second browser reaching the same
  server, and the honest answer is that it shows the last thing it was told.
- **A second register per shop.** The freeze makes the numbering safe with one, but a
  second till is its own piece of work (README's *Not built yet*).
- **The printer-less slip** (a picture the till draws) — its own work, its own ADR.
- **Selling by weight.** Goods are sold in whole units (`CONTEXT.md` item 14).
- **The multi-tenant hosted version of all this** (ADR 0016): one shop, one deployment.
- **A local server in the shop.** The cheap substitute for this entire specification,
  recorded in ADR 0019 as the rejected alternative.

## Further Notes

- **The order matters, and it is the order of the phases below, which the ticket list
  follows:**

  1. The pure decisions and their tests. No browser, no schema. **Built.**
  2. The reservation protocol on the server and its migration: `number_blocks`, the freeze
     inside the allocating statement, borrow / report / cancel. Proven against real
     Postgres. **Built.**
  3. The device store and the offline sale: catalogue snapshot, cash bill, local number,
     the till's offline state — **and the sale endpoint accepting a device's own number,
     which is the step that makes borrowing safe to use**.
  4. The replay: idempotency, the day-attribution change across the reports, the
     negative-stock task.
  5. The proof: `acceptance` extended, the runbook pages written, README's counts and
     its "not yet proven" list updated.

- **Which ADRs this owes.** ADR 0019 carries the decision and its price. The numbering
  protocol earns its own ADR when phase 2 lands (it is a document-series rule, and it
  is the one a later reader will want to change); the day-attribution change belongs
  with phase 4. The rule from `AGENTS.md` applies: each lands in the same commit as
  the behaviour it records.
- **What a shop is told.** `docs/renter-onboarding.md` gains a short section: what
  still works with no internet, what to do with the slip, how to send what is waiting,
  and that the customer display goes quiet. A counter-facing change is a change to
  that document in the same commit.
