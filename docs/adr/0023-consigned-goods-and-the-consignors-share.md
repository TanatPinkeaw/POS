# ADR 0023 — Consigned goods and the consignor's share

**Status:** accepted (2026-10-02).

**Context.** A `member` wants to leave an item with the shop, have the shop sell it, and be
paid an agreed **percentage**. This is ฝากขาย — consignment — and it is the first feature in
this system where the shop sells goods it does **not own**, which means the money path has to
answer a question it never has: *of the money this sale took, how much is the shop's and how
much is a debt to somebody else?*

The temptation is a second inventory — a consignment stock table beside `products` — and a
second sales path beside `createPosSale`. That duplicates the oversell guard, the safety
quantity, the offline snapshot, the tax arithmetic and the reporting: the exact money-path
duplication this repository has spent its ADRs avoiding. The decision is to reuse the one
money path and add only what consignment genuinely needs — an owner, a percentage, and a
ledger of what is owed.

## Decisions

### 1. The consignor is a member; only an admin sets consignment up

The person consigning is an existing `member` — they already have an identity to be paid
and contacted, and the shop already knows them. Only an **admin** puts a product into
consignment or changes its terms, because goods belonging to somebody else inside the shop
is a liability, not a counter operation.

### 2. Consignment is a property of the product, with a payable ledger

- `products.consignor_user_id` — the member who consigned it (null for shop-owned stock).
- `products.consignor_share_percent` — the agreed percentage for that product.
- `consignor_payables` — a ledger of what the shop owes each consignor: credits from sales,
  debits from refunds and payouts.

A product is **either** shop-owned **or** consigned to exactly one member; a consigned item
usually has quantity one. This keeps `stock_qty`, the oversell guard, the safety quantity,
the offline snapshot and every report working unchanged.

### 3. The shop sells as principal

The sale is the shop's own: its receipt, its series, its VAT, unchanged. The consignor's
share is recorded as a **payable** — a debt the shop owes — not as a split of revenue. The
accounting treatment of a shop selling goods it does not own (principal versus agent, and
where VAT and revenue recognition land) must be confirmed by the shop's accountant; this
decision picks the shape that leaves the existing documents and numbering untouched, which
is the shape to defend until an accountant says otherwise.

### 4. The share is a percentage of the net, excluding VAT

`share = round(net_excl_vat × percent)`. VAT belongs to the state, not to the shop or the
consignor, so it is not part of the base. **The satang remainder is absorbed by the shop**,
so the consignor's figure is a clean percentage rather than a rounding argument.

### 5. The share is recorded in the same transaction as the sale

There are exactly **two** places a sale completes, and both compute the share as they write
the money: `createPosSale` (a walk-in bill) and `completeOrder` (a pre-order handover). Each
writes a `consignor_payables` credit in its own transaction, so a sale that rolls back owes
nobody, and a credit can never exist for a sale that did not.

### 6. A refund claws the share back

Refunding a consigned sale returns the goods to the consignor, so the share returns with
them: the refund writes a `consignor_payables` debit. If a payout has already gone out, the
debit leaves a negative balance that the next payout nets against — the same shape
`points_forgiven` already uses for a clawback that cannot be taken back.

### 7. Consigned stock is not the shop's inventory

Consigned goods are **excluded** from the shop's stock valuation at cost (the shop did not
buy them) and reported separately, so an owner's "มูลค่าสต็อก" does not count somebody
else's goods as their own.

### 8. Consignment v1 is counter sales and pre-orders, never offline

A consigned product **cannot be sold offline** — the till's device snapshot does not carry a
consignor, so an offline consigned sale would owe a share it could not compute or record.
It **can** be pre-ordered, because a pre-order handover is an ordinary, connected completion
(`completeOrder`), and that is where its share is written.

### 9. What happens to unsold consigned goods

A consignor's unsold goods are withdrawn by an **admin**, as a stock adjustment with its own
SRS §4.3 movement and an audit row. **The share is paid only when an item sells**: goods
lost, damaged or stolen before a sale are not a share the system owes, and any compensation
is a matter for the shop's own agreement outside this system.

## Consequences

- **Two share-computation sites**, and both must stay in step — the integration point to
  watch in review.
- **Payouts leave through the door money already uses**: an open drawer or the shop's own
  banking app, with a statement document and an audit row — never an automatic transfer
  (ADR 0004's rule for money leaving the till).
- **Reports gain a consignor dimension**: sales, shares owed, and consigned stock as a
  separate figure.
- **The consignor sees their own position** through the customer portal (ADR 0020): the
  items, what has sold, and what is owed.

## Rejected

- **A separate consignment stock table.** Duplicates the oversell guard, safety quantity,
  offline snapshot and reporting — the money path, twice.
- **Per-unit ownership** (some units of one product consigned, others shop-owned). More
  model than a shop with per-item consignment needs; a product is one or the other.
- **The consignor sets the price.** The shop's shelf price stays the shop's; the consignor
  may propose and the terms are agreed at consignment, with changes audited.
- **Offline consignment sales.** The share owed to an outside party is exactly the kind of
  money-out event the offline path refuses.

## Known gaps

- **Accountant sign-off on principal versus agent** and on revenue recognition is required
  before a shop trades this way; this ADR records the shape, not the tax opinion.
- **No online consignment sale** in v1, by decision, not oversight.
- **The money path is built end to end; only the accountant's sign-off and the online sale
  remain.** A product carries a consignor and a
  share, `consignor_payables` is the ledger, the pure rule that turns a net sale into a share
  and a refund's reversal lives in `src/lib/consignment-rules.ts`, and an admin can consign a
  product or withdraw unsold goods from `/admin/products` — each audited. `recordConsignorShares`
  is called inside the sale's own transaction at both completion sites — `createPosSale` and the
  pre-order handover in `completeOrder` — and computes each consigned line's credit from the
  order's own `net_amount` (split across the lines by `lineNetExclVat`), so a rolled-back sale
  owes nobody. `recordConsignorRefunds` is called inside the refund's own transaction in
  `refundOrder` and writes one debit per returned consigned line, proportional to the units that
  came back (the note that closes a line takes the remainder, so the debits sum to the credit and
  a full refund lands the balance on zero); a payout already made leaves a negative balance the
  next payout nets. The dashboard's stock valuation counts only owned products, and the
  consigned stock and shares owed are reported beside it in a separate block whose owed figure
  is the ledger's own sum — so a consignor's goods are never filed as the shop's own. The till's
  own view of a product carries `isConsigned`, the offline catalogue snapshot keeps it, and the
  offline decision refuses a consigned line with a Thai message that names the next step
  (connect) — while a pre-order, which completes online, is untouched. **The payout is built**
  (`src/lib/consignment-payout.ts`): `payConsignor` settles a consignor's balance from the open
  drawer or by transfer (ADR 0004 — cash requires an open `cash_shifts` row and carries its
  shift, a transfer carries none), refuses an amount above the balance, and in one transaction
  writes a `consignor_payouts` row (the statement), the ledger's `payout` debit pointing back at
  it via `payout_id` (the `chk_consignor_payables_payout` CHECK keeps the debit and its paper
  inseparable) and an audit row (`consignment_paid`). A cash payout counts out of the drawer, so
  the shift close still reconciles. `/admin/consignors` is the admin screen: the balances owed,
  each consignor's account, a payout form, and the statement a payout produced. **The consignor
  sees their own position** in the customer portal's ฝากขาย tab (`src/lib/consignment-portal.ts`):
  `loadCustomerConsignment` reads the same ledger by the signed-in member's own id — the balance
  is the ledger's own sum, the items list what they have left with the shop and how much of each
  has sold, and every movement appears newest first, a payout reading as a settled statement and
  a refund as a reversal. Because the read is scoped by the caller's id, one phone number can
  never see another consignor's balance. That closes every ticket under `.scratch/consignment/`.

## §7 — Where a consignment comes from

Everything above describes a consignment the shop already had. ADR 0025 adds the door a
member actually walks through: they fill in the offer form in their own ฝากขาย tab, and
the owner's inbox on `/admin/consignors` decides it. The rule in this ADR is unchanged
and is the one that runs — an approval calls `setConsignment`, so the share is set by the
same code, under the same conditions, as it always was. **An offer is not an arrangement:
only an owner agrees a share.** The documents a member attached follow the product the
offer became, and the member's own page reads the consignor from their account rather than
from the offer. See ADR 0025 §2, §3 and §4.
