# Consignment (ฝากขาย)

Status: ready-for-agent

Authoritative specification: [ADR 0023](../../docs/adr/0023-consigned-goods-and-the-consignors-share.md).
Related: [ADR 0020](../../docs/adr/0020-a-customer-signs-in-with-google.md) (the consignor's
portal is the customer portal), [ADR 0004](../../docs/adr/0004-credit-notes-and-refunds.md) /
[ADR 0008](../../docs/adr/0008-partial-refunds.md) (a refund is a credit note, and it claws the
share back), [ADR 0019](../../docs/adr/0019-the-till-sells-offline.md) (why a consigned
product may not be sold offline).

## Approved scope

A member (**consignor**) leaves goods with the shop; the shop sells them and owes an agreed
**percentage** of the net (excluding VAT), accumulated as a **payable** and paid out through
the drawer or a transfer with a statement. Reuse the existing money path, not a second one:

- `products.consignor_user_id` (nullable) and `products.consignor_share_percent`; a product is
  either shop-owned or consigned to exactly one member.
- A `consignor_payables` ledger: a credit per consigned sale line, a debit per refund and per
  payout.
- The share is written **in the same transaction as the sale**, at the two completion sites
  (`createPosSale`, `completeOrder`).
- The share is a percentage of the **net, excluding VAT**; the satang remainder is absorbed by
  the shop.
- Consigned goods are **excluded** from the shop's owned stock valuation and reported
  separately.
- A consigned product **cannot be sold offline**; it **may** be pre-ordered (share written at
  handover).
- Only an **admin** creates or changes a consignment, and only an admin withdraws unsold
  goods (as a stock adjustment with an audit row).

Out of scope, by decision: per-unit ownership; more than one consignor per product; the
consignor setting the price; offline consignment sales; automatic payouts.

## Test seams

A pure `consignment-rules.ts` (share from a net amount and a percent, refund reversal,
ledger arithmetic) with unit tests, and server tests against real PostgreSQL: a consigned
sale writes exactly one payable credit; a rolled-back sale writes none; a refund writes the
debit; a payout nets the balance and cannot overpay; consigned stock never lands in the owned
valuation; an offline replay of a consigned product is refused (never reaches the ledger).

## Delivery

Tickets are worked blockers-first as red/green slices, then reviewed on the Standards and Spec
axes. The accountant's confirmation of principal-versus-agent treatment (ADR 0023) is a
**release blocker for a real shop**, not for the code. Nothing is committed to `main` except
by the owner's decision; the offline work already in the tree is left untouched.
