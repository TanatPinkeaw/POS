# ADR 0004 — Credit notes, refunds, and where the money comes back from

**Status:** accepted
**Context:** ADR 0002 left one gap open by name — *"a VAT-registered shop could not
legally be served at all"* was fixed, and the revisit trigger it recorded was
literally *"a renter asks how do I refund this?"*. This ADR is the answer, and it
is the item the competitive gap analysis ranked first: the only entry on that list
where not building it means a shop cannot legally trade.

---

## The gap

Receipt numbers here are gapless and never reused, which is the right behaviour
and is enforced by allocating the number inside the sale's transaction (ADR 0002
§4). An order can also be cancelled — from any of the four pre-order phases, with
its stock returned.

Those two facts together left a hole nobody had asked about yet:

- A **completed** sale could not be reversed at all. `TRANSITIONS.completed = {}`
  made "settled" mean "final", so the only way to undo a bill was to edit the
  database.
- A shop that had issued a **VAT invoice** had no compliant way to reverse one.
  Reusing the invoice number is forbidden, and there was no second document to
  issue instead.

In Thai practice the reversing document is a **`ใบลดหนี้` (credit note)**: its own
numbered document, referencing the invoice it reverses, carrying the same tax
breakdown and the reason the money went back. That is what this builds.

---

## Decisions

### 1. Full amount only, one credit note per receipt

One credit note refunds the whole bill and returns every line. Partial refunds —
"return two of the three items" — are refused, and the honest reason is scope: the
arithmetic is per-line across a tax breakdown that was computed from a bundle
totals figure, and a per-line refund that got that wrong would put a wrong number
on a legal document. Doing the whole reversal correctly is worth more than doing
the partial one approximately.

The shape does not block it. The credit note's figures are **snapshotted onto the
document** rather than read back through the sale, so a later partial refund is a
change to one function and its table, not a migration that has to reinterpret
existing rows.

The database guarantees the rest: `credit_notes.order_id` is `UNIQUE`. The state
machine refuses a second refund before a transaction opens
(`completion → refunded` is the only edge in, and `refunded` is terminal), and the
unique index is what catches two requests that both got past the check.

### 2. A refunded sale has its own status; the reports keep gross

`order_status` gains `refunded`. The alternative — a nullable `refunded_at` with
the status left as `completed` — was rejected because the question "has this bill
been reversed" then has as many answers as there are queries, and every one of
them has to remember to ask.

The consequence is deliberate and was chosen rather than discovered: **refunds are
their own line and sales stay gross.**

- A bill paid on Monday and refunded on Friday stays in Monday's takings and
  appears in Friday's refunds. That is the only reading that lets an owner
  reconcile a week against a bank statement, and it is why `analytics.ts` includes
  `refunded` in its sales queries and adds a separate `refundsThb` figure.
- Every place that filters `status = 'completed'` and means "money was taken" now
  filters `status IN ('completed', 'refunded')`. `OrderStatus` is a closed union,
  so the compiler enumerates those sites rather than trusting anyone to remember
  them: analytics (3), the sales and product-performance report queries (2), the
  customer display's best-sellers (1).
- The SRS §8 column headers are fixed and were therefore left alone, so the
  `sales_summary` sheet gained no refund column. The reversal is visible in the
  sheets that already had a place for it — `stock_audit` shows a `pos_refund`
  movement per returned line — and in the audit trail, which records the document
  number, the amount, the reason and both people.

### 3. Money direction is a column, not a sign

`payments.amount` carries `CHECK (amount > 0)` from the initial migration, and the
obvious move — a negative refund leg — would mean dropping it. It was kept, and
`payments.direction` (`sale` | `refund`) was added instead.

An amount is a magnitude. A table where "how much" and "which way" are the same
field is a table where every sum, present and future, has to be written signed and
correctly; one column that states the direction once means each aggregate either
nets it deliberately or filters on it deliberately, and neither can happen by
accident. Two aggregates were changed, both in `cash-shifts.ts`:

- `cashSalesForShift` nets cash refunds, so the drawer expects what is actually in
  it. A cashier who has just handed ฿107 back is short exactly that, and a figure
  that did not move would send them hunting for a discrepancy they created
  correctly.
- `orderCountForShift` filters to sale legs, so a refund is not counted as a bill
  the refunding shift sold — and not counted twice, once in each shift.

A CHECK ties the two columns together:
`("direction" = 'refund') = ("credit_note_id" IS NOT NULL)`. Money cannot leave
the till with no document explaining it, and an ordinary sale cannot claim one.

### 4. Money goes back through the drawer, or by hand — never automatically

This is the decision the whole refund path follows from, and it is a business
arrangement rather than a technical one: **pushing money back to a customer's bank
account automatically needs a PSP relationship and a fee per transfer**, and this
product's promise is software a shop owns and runs.

So a refund is one of two things, and the operator chooses:

- **`cash`** — out of the drawer that is open *now* (not the one the sale was
  taken in), written against that shift, and refused with `NO_OPEN_SHIFT` when
  there is none. It reduces that shift's expected cash, which is what makes the
  close reconcile.
- **`promptpay`** — a transfer the cashier already made in the shop's own banking
  app, recorded with `shift_id = null`. It never touched a drawer, and writing it
  against one would invent a shortage. This is the same reasoning that gives a
  points leg no `shift_id` when a pre-order is collected.

Exactly **one** refund leg is written, for the full amount, in the tender the money
actually went back in — not one leg per original tender. The customer paid by
transfer and took cash; a "promptpay refund" that no bank performed would be a
false line in the one place a shop is obliged to be accurate. How the *sale* was
paid is restated on the credit note as a document fact instead, and the receipt
route filters refund legs out so a reprint of the original still adds up.

The asymmetry with sales is worth naming: money in *can* be automatic — a
PromptPay QR and a bank-notification bridge — because receiving needs no
relationship. Money out cannot, so the till asks a person.

### 5. A refund is a gated action, always

`audit_action` gains `refund_order` and the supervisor vocabulary gains a fifth
action. Unlike cancelling a pre-order — which a member does for themselves, and
which is not audited — a refund is **always** a supervisor's decision, whatever
the operator's role. It is strictly more dangerous than a void: a void stops a
sale that was never paid, a refund pays money out of a drawer. An owner alone in
the shop approves their own refund with their own PIN, which leaves a trail naming
both roles rather than an unaudited hole.

The approval is bound to the order id, so an approval to refund ฿30 cannot be
spent on a ฿3,000 bill — the amount comes from the order, never from the request.

### 6. Points are best-effort, and can never block a refund

`applyPointChange` refuses to drive a balance negative, which is correct: a
negative balance means a redemption was approved against points that no longer
exist. But a customer who has already spent the points they earned must not be
unable to return their goods.

So the clawback is **clamped to the available balance**, and the shortfall is
recorded on the credit note as `points_forgiven` and printed on the document. "We
forgave 12 points" is a fact an owner can act on; a customer held at the counter is
not. Points redeemed on the sale are returned unconditionally — that discount was
paid for with points, and the sale it paid for no longer exists.

### 7. The credit note is a document, and it reprints from its own snapshot

Its own gapless series (`shops.credit_note_prefix`, `→_running_number`), because a
shop's invoice series and its credit-note series are two documents an auditor reads
against each other, and interleaving them would make "how many invoices did you
issue" a question about a shared counter.

Its tax figures, rate and reason are stored on the credit note, so a reprint in
2027 shows what was reversed in 2026 — the same rule a receipt follows (ADR 0002),
for the same reason. Only the shop's *identity* follows the current settings: a
renamed shop reprints under its new name.

The series is bumped inside the refund's transaction, so a refund that rolls back
does not burn a number, and the shop row is locked **before** any product row
because every transaction that touches both takes them in that order.

---

## Consequences

- A renter can now reverse a sale they have invoiced, with a document that
  references the original. `docs/renter-onboarding.md` says how.
- Gross sales figures did not move for a past day; refunds are their own figure on
  the dashboard and their own movements in the stock report.
- Two migrations now exist where a schema change would previously have been one:
  `pos_refund`, `refund_order` and `refunded` are all enum additions. That cost is
  the point of a closed audit vocabulary, and it was paid knowingly.
- The stock-availability invariant is untouched: a refund moves `stock_qty` only,
  through `returnRefundedStock`, because a completed sale holds no reservation.
  `holdsReservedStock` stopped being a derivation of `isTerminal` for exactly this
  reason — `completed` is no longer terminal, and deriving one from the other would
  have claimed a paid sale was still holding somebody's pre-order.

## Known gaps, stated rather than discovered

- **No partial refund.** See decision 1.
- **The till can only refund the bill on screen.** A customer who returns tomorrow
  with a paper receipt is served from the back office, where the recent-orders
  table offers the receipt, the refund and the credit note. A lookup by receipt
  number at the till is the obvious next step and is recorded in `AGENTS.md`.
- **No e-tax submission, no e-signature, no withholding-tax lines.** Unchanged
  from ADR 0002.
- **The refund is not sent anywhere.** It is recorded; a transfer is made by a
  person in the shop's banking app. Decision 4.
