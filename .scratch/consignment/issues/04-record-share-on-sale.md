# 04: Record the share in the sale's own transaction

**What to build:** Every consigned sale writes one payable credit, in the same transaction
that writes the money, at both places a sale completes.

**Blocked by:** 01, 02.
**Status:** done

- [x] `createPosSale` writes a `consignor_payables` credit for each consigned line.
- [x] `completeOrder` (a pre-order handover) writes the same credit — the second site.
- [x] The share is computed by the pure rule (ticket 02) from the line's net excluding VAT.
- [x] A sale that rolls back owes nobody: no credit exists without a committed sale.
- [x] Tests: one credit per consigned line; none for a shop-owned line; none when the
      transaction rolls back; a pre-order handover credits at handover, not at placement.

## Notes

Two write sites are the integration point to watch in review; a shared helper both call keeps
them from drifting. This is the same "the database is what makes it true" shape the rest of
the money path uses: the credit is written with the sale, not after it.

## What was built

- **`src/lib/consignment.ts` — `recordConsignorShares(db, { orderId, at })`.** The shared helper.
  It reads the *committed order* (`net_amount`, `subtotal_amount`) and its lines, not a cart,
  and for each line whose product has a consignor writes one `consignor_payables` row:
  `kind: 'sale'`, `amount_thb` = `shareFromSale(lineNet, percent)`, with `order_id`,
  `order_item_id`, `product_id`, a Thai description, and `created_at` set to the sale's own
  instant so the ledger and the order agree about which day a sale is in. A shop-owned line is
  skipped; a credit is written even when the share rounds to zero, because a zero row is the
  record that the line sold.
- **`src/lib/consignment-rules.ts` — `lineNetExclVat(netAmountThb, lineTotalThb, subtotalThb)`.**
  The order's net belongs to the whole bill, so a single line's net is the order's net allocated
  by what the line was charged — the same pro-rata rule `refund-plan.ts` uses for an
  order-level discount. All arithmetic in integer satang.
- **Two call sites, both inside the sale transaction:**
  - `createPosSale` — after `order_items.createMany`, before the stock moves.
  - `completeOrder` — after the order's `taxColumns` are written, so the handover's share is
    computed from the same `net_amount` the sale keeps. Written *after* the status update so a
    share can never be recorded for a handover that did not complete.
- **Tests.** `tests/consignment-sale.test.ts` (8, real PostgreSQL): one credit per consigned
  line taken from the line's net excluding VAT; nothing for a shop-owned line; only the
  consigned line of a mixed cart; nothing when the sale rolls back; a pre-order handover credits
  at handover not placement; nothing for a shop-owned pre-order; nothing when the handover rolls
  back (and the order stays packed); and the balance accumulating across two sales. Four more
  unit tests for `lineNetExclVat` in `tests/consignment-rules.test.ts` (now 15).

## Continuation checkpoint

The ledger is written; nothing reads it back yet. Next is **ticket 05** — a refund claws the
share back (`refundReversal`, a debit row in the refund's own transaction), then **ticket 06**
(exclude consigned stock from the owned valuation and report it separately), **07** (refuse a
consigned product offline), **08** (payout with a statement and an audit row), **09** (the
consignor's own view in the customer portal).
