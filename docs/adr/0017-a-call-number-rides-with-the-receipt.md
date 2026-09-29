# ADR 0017 — The call number rides with the receipt

**Status:** accepted (2026-09-29). Round 1 of two: the number exists, is stored, and is
printed on the slip. The board that shows it to a room is round 2, and its direction is
recorded under Gaps rather than assumed.

**Context:** A customer waiting for a drink is called by a number. Every number this system
had before this one belonged to a *document*, and neither of them can be called out:

- **`orders.receipt_number` is the tax series and exists only for a VAT-registered shop.**
  `resolveSaleTax` allocates it when `breakdown.isVatInvoice` — measured, not remembered —
  so a shop that is not VAT-registered has no receipt number at all. That is most small Thai
  shops: registration starts at 1.8M THB a year. Their slip printed the fallback the receipt
  component already carries, `receiptNumber ?? orderNumber` — that is, `PO-20260929-000014`.
- **The receipt number is gapless on purpose** (ADR 0002 §4). It grows all year, it is long,
  and nobody shouts `FR-2026-000123` across a counter. A series that must not have holes is
  also a bad place to spend an identifier every time somebody orders a coffee.

So the shop's real choice was between shouting a document's name and shouting nothing.

## Decisions

1. **Every walk-in bill gets a short number: 1, 2, 3 … within one Bangkok day.**
   Universal — VAT-registered or not. The rejected alternative was the tidy-looking one:
   give a short number only to the shops that have no receipt number. It reads well until
   you notice the receipt number is *the same length either way* — so a VAT shop's customer
   would still be called by a number nobody can shout, which is the complaint this exists to
   answer. It would also make "how is this customer called" a question with two answers, and
   the receipt, the board and the lookup would each have to ask which kind of shop they are
   drawing for.

2. **The number is a stored fact about the bill, not a reformatting of the receipt number.**
   `orders.queue_number` (integer) and `orders.queue_day` (date), with
   `UNIQUE (queue_day, queue_number)`. Rejected: deriving the day from `created_at` — that is
   an instant, and between local midnight and 07:00 it names the previous day, which is
   exactly when a shop is open and precisely when a number matters. The day is stored for the
   same reason the tax facts are snapshotted: it is a fact about the bill, not something to
   recompute.

3. **The counter lives on the shop row and resets inside the statement that bumps it.**
   `shops.queue_running_number` / `shops.queue_running_day`, incremented by an
   `UPDATE … RETURNING` that sets the counter to 1 when the stored day is not today. Rejected:
   a PostgreSQL `SEQUENCE`. `nextval` is non-transactional, so a sale that rolls back burns a
   number — the hole ADR 0002 already refuses for receipts, and worse here, because two
   customers the same day would hear the same number and one of them would collect the
   other's order. Rejected: reading the row and comparing in TypeScript, because "same day?"
   and "bump the counter" would then be two statements another register can interleave, and
   the number returned could belong to a day that had already ended.

4. **The day is Bangkok's, and a sale has one instant.** `createPosSale` takes a single
   `new Date()` and uses it for the receipt's year, the call number's day and `completed_at`.
   Three reads of the clock would let a sale rung up at midnight name yesterday's year beside
   today's number. This is rule 10 in `AGENTS.md` applied to a new column.

5. **A pre-order gets no call number.** Its handover *is* the moment it is paid for, so a
   number to wait for would be a number nobody ever calls; it already has two identifiers for
   the handover — the bill number and the PIN or QR it was collected with (ADR 0006).
   `completeOrder` says so where it snapshots the tax, so the exclusion is legible at the site
   rather than inferred from a null.

6. **It is printed above the document's own number, and it is the loudest thing on the page.**
   Labelled **คิวที่**, at the largest size the 80mm sheet carries; the receipt number keeps its
   place and its label, and a VAT layout is not reordered. The formatter is a pure module
   (`src/lib/queue-number.ts`) with three call sites — the sale, the reprint, and the board to
   come — because a reprint that says `37` where the slip in the customer's hand says `037` is
   the same failure ADR 0002 forbids for figures: the copy has to match what was handed over.

## Consequences and gaps

- **Nothing shows the number to a room yet.** This round gives it a home on the bill. The
  direction for round 2 is decided and recorded here: staff advance the bill —
  **กำลังทำ → พร้อมรับ → รับแล้ว** — and the `/display` board shows those numbers. That state
  goes *beside* `orders.status`, never inside it: `completed` is what every money report
  counts, and a sale's money is finished the moment it is paid, whatever the drink is doing.
- **The number is reused across days, deliberately.** A customer holding yesterday's slip
  holds a number that today means somebody else. The reset is what keeps it short, and it is
  what every coffee shop's ticket does; a shop that wanted otherwise would want a longer
  series, not a different rule.
- **A void spends its number.** Nothing recycles it, exactly like the receipt series, and a
  refused sale burns none — the counter moves inside the sale's own transaction, so it rolls
  back with the sale.
- **A lookup over a date range is still the open item it was.** The number now exists to be
  searched by, but the screen that finds a bill from last week is still `README`'s *Not built
  yet*; this ADR does not claim it.
- **Two registers would serialise calls on the same row as receipts.** That is fine for the
  one till this deployment supports, and it is the same trade ADR 0002 §4 already records
  rather than a new one.
- **Measured:** `tests/queue-number.test.ts` — the day rollover either side of local midnight,
  the counter continuing across one day, a non-VAT shop still getting a number, a rolled-back
  sale burning none, a pre-order getting none, and the database refusing two bills that share
  a number on one day.
