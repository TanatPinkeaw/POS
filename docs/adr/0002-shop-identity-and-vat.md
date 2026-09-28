# ADR 0002 — Shop identity, tax, and receipt numbering

**Status:** accepted
**Context:** ADR 0001 recorded where the *database* departs from SRS §7. This ADR
is different in kind: it records a requirement the SRS never states at all.

---

## The gap

SRS §7 (the DDL) and §3 (receipts, drawer reconciliation, loyalty) together
describe a shop that has no identity and no tax. That is not a simplification —
it is missing, and it showed up in the running application as:

- the receipt header was the bare string `ใบเสร็จรับเงิน` — **no shop name, no
  address, no tax id, no branch**;
- the page title was `POS Realtime · …` — our name, on the renter's system;
- the shop's name could not appear anywhere, because nothing stored one;
- there was no VAT rate, no taxable base, and no tax line on any document.

Two consequences, one commercial and one legal:

1. A renter could not put their own name on a document they hand to a customer.
2. A VAT-registered Thai shop could not legally be served at all.

The second is the reason this was done before any further feature work: a
correctness gap outranks a missing feature.

---

## Decisions

### 1. A shop is a singleton row, enforced by the primary key

```sql
CREATE TABLE "shops" ( "id" INTEGER NOT NULL DEFAULT 1, … PRIMARY KEY ("id") );
ALTER TABLE "shops" ADD CONSTRAINT "chk_shops_singleton" CHECK ("id" = 1);
```

Two requests racing through the setup wizard must not both win. Application code
can only offer a read-then-write check, which loses that race; a primary key
cannot. The `CHECK` is redundant next to `id = 1` but makes the intent legible to
whoever reads the DDL rather than the decision record.

**Consequence, stated plainly:** there is no `shop_id` on the other dozen tables
and no multi-branch support. A second branch is a second deployment.

### 2. Tax facts are snapshotted onto the order, never recomputed

Five columns on `orders` — `net_amount`, `vat_amount`, `vat_rate_used`,
`is_vat_invoice`, `receipt_number` — plus:

```sql
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_vat_reconstruction"
  CHECK ("net_amount" + "vat_amount" = "final_amount");
```

A reprint in 2027 of a 2026 receipt must show 7% even if the rate has changed, and
`vat_rate_used` is what makes that expressible. The `CHECK` is there because a tax
receipt whose lines do not add up is not a rounding nit — it is a document that
does not balance — and the database is the only place that can refuse it for
*every* future writer of that table.

Orders that predate this migration were backfilled with
`net_amount = final_amount, vat_amount = 0`: history is not retroactively given a
tax line it never had, and that backfill is what makes the constraint satisfiable
on a database that already contains orders.

### 3. Inclusive pricing by default, and the sale arithmetic does not change

`prices_include_vat` defaults to `true`, which is the Thai retail norm: the price
on the shelf already contains the tax, so the tax is *derived out of* the amount
due. The customer still pays `subtotal − discount`, exactly as before — only the
breakdown is new. That is why the 117 tests that existed before this change still
pass untouched. Exclusive pricing is supported for shops that quote pre-tax.

`vatFromInclusive` computes `tax = round(gross × rate ÷ (100 + rate))` and takes
the base as the **remainder** rather than rounding it independently, which is what
makes `net + vat === gross` exact at satang precision. Asserted over thousands of
random amounts.

### 4. An order number and a receipt number are different things

- `order_number` (`PO-20260101-0042`, from a sequence) is the **operational**
  identifier: what the pre-order board shows and what staff say out loud.
- `receipt_number` (`RC-2026-000001`, `UNIQUE`) is the **legal document series**.

Postgres sequences are atomic but **non-transactional**: a sale that rolls back
after calling `nextval` has still burned the number, and a tax series with a hole
in it is a question an auditor asks. So the receipt counter is a column bumped by
`UPDATE … RETURNING` *inside* the sale transaction, which makes `ROLLBACK` restore
it along with everything else.

The cost, stated plainly: receipt issuance serialises on the shop row. That is
correct for one till, and it is the first thing to revisit before a shop runs two
registers.

### 5. `REASON_IMPORT` joins the adjustment-reason enum

A spreadsheet's opening balance is neither a human count nor a restock. Without
its own enum value, an import is indistinguishable from somebody having counted
the shelves — which is exactly the distinction an auditor cares about.

### 6. `products.category_id` became `ON DELETE RESTRICT`

It was `SET NULL`. Deleting a category that still has products silently orphaned
them into "uncategorised"; the database now refuses, and the API explains.

### 7. The demo seed refuses to run against a configured shop

`npm run db:seed` checks for a shop row and exits non-zero with an explanation;
`npm run db:seed:demo` is the explicit override for a throwaway database. A seed
that pours demo products into a shop somebody is trading from is the classic way
to destroy a weekend of real data, and a documented warning is not a guard.

### 8. Setup is a gate, not a page

`/setup` and `/api/v1/setup` are public paths and *refuse with 409* once a shop
exists. `/login` redirects to `/setup` when the deployment is unconfigured, so a
fresh install cannot dead-end on a login screen nobody has credentials for.

The public-path table lives in `src/lib/roles.ts`. The proxy runs on the edge
runtime and cannot query the database, so it only decides "this path needs a
session at all"; the meaningful check runs in the Node-runtime page and handler,
with the singleton primary key as the backstop that cannot be raced.

### 9. The shop and its first administrator are created in one transaction

A failure after the shop row would leave a deployment that is "set up" — so the
wizard closes — and has no way in. The two rows are written together.

---

## What this deliberately does not do

- **It is not a compliance certification.** The receipt layout follows typical
  Thai retail practice (shop name, branch, tax id, receipt number, date, line
  items, base, VAT, total). Whether a given shop's documents satisfy the Revenue
  Department is its accountant's call. This encodes the *format*, not an opinion.
- ~~**No void / credit note.**~~ **Closed by ADR 0004.** Receipt numbers are
  gapless and un-reusable, which is right — and it means the only honest way to
  reverse an invoice is a second document that references it. That document now
  exists (its own series, its own tax snapshot, a supervisor's PIN behind it), and
  the original number is still never reused.
- **No logo upload.** `shops.logo_url` exists and the settings screen reads it;
  nothing writes it yet.
- **No multi-shop or multi-branch** (decision 1).
- **No e-tax submission, no e-signature, no withholding-tax lines.**

## Revisit triggers

- A second register at one shop → decision 4's serialisation becomes the
  bottleneck.
- The shop becomes VAT-registered mid-year → new orders must carry the new rate
  while old receipts reprint at the old one. Both already hold.
- ~~A renter asks "how do I refund this?"~~ → **triggered, and answered by ADR
  0004.** The next schema trigger in this family is a shop asking to *send the
  refund automatically*, which needs a PSP relationship rather than a schema
  change — see ADR 0004 decision 4.
