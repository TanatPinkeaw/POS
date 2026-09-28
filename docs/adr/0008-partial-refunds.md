# ADR 0008 — Partial refunds: the note itemises, the closing note takes the rest

**Status:** accepted (2026-09-28)
**Context:** ADR 0004 decision 1 refused partial refunds by name, and left the
revisit trigger in writing: the credit note snapshots its own figures "so a later
partial refund is a change to one function and its table". It also named the
reason it was refused — "returning two of the three items" is the everyday case,
and the arithmetic is per-line across a tax breakdown that came from a bundle
total. This ADR is that function and that table, and it supersedes ADR 0004
decisions 1 and 2 in exactly one respect each: a sale may now have several credit
notes, and a partial one leaves the bill `completed` rather than `refunded`.

## Decisions

### 1. The note itemises what it reverses

`credit_note_items` records the lines and quantities going back, one row per line
per note, with a `CHECK` that the row's `line_total` equals `unit_price × quantity`
rounded to satang. That is what makes the document a credit note rather than a
free-form adjustment, and it is what a later refund reads to know how much of each
line is still refundable.

What was refunded is therefore **derived** — the sum of a line's rows across every
note — rather than a `order_items.refunded_quantity` denormalised column. A column
would need its own invariant (never exceed the quantity sold) and a second writer
to keep it true; a sum cannot drift, and the constraint it needs (a note cannot
return more than was sold) is checked in the transaction that would break it.

### 2. Several notes per sale, numbered within it, and the order's totals never move

The unique index moved from `order_id` to `(order_id, sequence)`, so the first note
on a bill is still unique per sale and the fourth is unremarkable. `sequence` is
1-based and printed on the document, so "the second note on bill FR-2026-000042" is
a thing a person can say out loud.

The order's own `subtotal`, `discount`, `final`, `net`, `vat` and `receipt_number`
are **not touched**. An invoice that has been partly credited is still the invoice
that was issued, and rewriting its figures would destroy the document the credit
note exists to point at. A sale is `refunded` when, and only when, the notes have
taken back everything on it; a partial one leaves it `completed`.

### 3. The closing note takes the remainder instead of computing its own share

This is the decision the arithmetic turns on, and it lives in `src/lib/refund-plan.ts`
as a pure function with the tests to match. A partial refund has to split an
order-level discount across the lines coming back, and a two-decimal round of that
split leaves a satang somewhere. **The note that empties the order is defined by
subtraction** — the invoice, less what the earlier notes already gave back — so no
split of one sale can strand a satang, however many visits it takes.

Every earlier note rounds its pro-rata share (`discount × gross ÷ subtotal`), and
the discount on the document is the residual in both cases, which is what keeps
`gross − discount = final` true on every note rather than approximately true. The
same trick is applied to the tax: the closing note takes the net the earlier notes
did not round to, so the sale's own net and VAT are reconstructed exactly by the
notes that reverse it (`refundTax`'s `netOverride`).

The figure is summed in satang throughout. Three notes of ฿31.66 reach
฿94.99000000000001 in floating point, and this number ends up on a legal document.

### 4. A line that does not split evenly leaves its satang on the closing note

The sale records a line **total**, not a unit price, so returning one of three
units of a ฿100 line divides evenly at ฿33.33 and leaves one satang of gross on the
closing note. That is a deliberate trade: inventing a unit price the sale never
recorded would put a number on the document that no invoice supports, and the
remainder is exactly where every other remainder in this module lands anyway. The
alternative — refusing the refund because the total does not divide by three — is
a shop that cannot serve a customer over a rounding rule.

### 5. The till asks per line, and the preview is the same function

`POST /api/v1/orders/{id}/refund` accepts `lines: [{ orderItemId, quantity }]`; a
body with no `lines` still means "everything outstanding", which is what the till
sent before partial refunds existed and what a one-tap full refund still sends.
The dialog lets the cashier tick rows and type quantities, and previews the amount
by calling the same pure planner the server calls — so the number the cashier reads
out to the customer and the number the server writes to the note come from one
implementation, not two.

The gate is unchanged and unconditional (ADR 0004 decision 5): a supervisor's PIN,
bound to the order id, for every refund, whole or partial.

### 6. The money, the stock and the points follow the plan, not the bill

Only the lines on the plan go back to `stock_qty`, as `pos_refund` movements, so the
SRS §4.3 adjustment log explains each returned unit in its own words. Only the
points those lines earned are clawed back, clamped to the available balance with
the shortfall recorded as `points_forgiven` (ADR 0004 decision 6, unchanged). Only
one refund leg is written, for the plan's amount, in the tender the money went back
in.

## Consequences

- A customer returning one item out of three is served at the counter, and the
  invoice survives for the next visit — which is what makes a multi-visit return
  possible at all.
- The credit note is now a document with children, so the reprint reads its own
  line rows rather than restating the sale. The tax figures are still snapshotted
  on the note, so a 2027 reprint shows what was reversed in 2026.
- `credit-notes.test.ts` and the new `partial-refunds.test.ts` cover the seams: a
  three-way split of a discounted bill foots to the invoice, a second note on the
  same line is refused, and the bill is `refunded` only when the last unit is back.
- The acceptance journey rings up a two-line sale, refunds one bottle, and then
  comes back for the rest, asserting the two notes add up to the invoice exactly.

## Known gaps, stated rather than discovered

- **No refund without a line.** There is no free-form amount. An amount that
  matches no line is a document that proves nothing, and it is the reason the
  original design refused partials at all — the line rows are what keep it honest.
- **No per-note tender split.** One refund leg, for the whole note, in one tender.
  ADR 0004 decision 4.
- **No exchange flow.** A return-and-replace is two transactions a cashier rings
  in sequence; the software does not tie them together.
- **The till can only refund the bill on screen.** Unchanged from ADR 0004, and now
  more visible: a customer who wants to return *some* of a bill from last week is
  served from the back office.
