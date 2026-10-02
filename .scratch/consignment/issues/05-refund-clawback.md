# 05: A refund claws the share back

**What to build:** Refunding a consigned sale debits the consignor's payable by the share the
sale credited.

**Blocked by:** 04.
**Status:** done

- [x] A refund of a consigned line writes a `consignor_payables` debit for the same share.
- [x] A partial refund debits only the returned quantity's share.
- [x] A debit that leaves a negative balance is carried forward and netted by the next payout,
      rather than blocking the refund.
- [x] Tests: refund after sale → balance returns to zero; partial refund → the exact share;
      refund after a payout → negative carried, next payout nets it.

## Notes

The goods go back to the consignor, so the share goes with them (ADR 0023 §6). Follows the
existing refund transaction (ADRs 0004, 0008); the points clawback is the precedent for a
balance that may go negative without blocking the customer.

## What was built

- **`src/lib/consignment-rules.ts` — `clawbackFromLine(creditedShareThb, alreadyReversedThb,
  refundedQty, lineQty, closesLine)`.** The pure rule, non-negative (the caller signs it). A
  partial refund takes the returned units' pro-rata share, rounded once in satang — the same
  allocation `lineNetExclVat` uses. The note that takes a line's last unit takes the
  **remainder** instead of rounding again, so however many visits a line comes back in, the
  debits sum to the credit and the balance lands on zero. That is the rule the discount
  allocation (`refund-plan.ts`) and the points clawback (`credit-notes.ts`) already use.
- **`src/lib/consignment.ts` — `recordConsignorRefunds(db, { orderId, at, lines })`.** The writer.
  For each returned line it reads the credit the sale wrote (`consignor_payables` where
  `kind = 'sale'`) and the magnitude earlier notes already reversed, then writes one
  `kind: 'refund'` row, negative via `refundReversal`, with the same `order_item_id`/`product_id`
  and the *creditor's* `consignor_user_id`. It deliberately does **not** recompute the share
  from the refund's money: a line's terms may have been re-agreed after the sale, and the ledger
  is a sum of what was actually written. A line with no `sale` row (shop-owned, or sold before
  the ledger existed) is skipped. Nothing checks the resulting balance — a payout already made
  leaves it negative on purpose.
- **`src/lib/credit-notes.ts` — one call in `refundOrder`.** After the stock goes back and before
  the refund's own payment leg, inside the refund's transaction, so a rolled-back refund claws
  nothing back. `closesLine` is computed from the sale quantity, what earlier notes took, and
  what this note takes — carried from the refund's own plan rather than re-queried.
- **Tests.** `tests/consignment-refund.test.ts` (6, real PostgreSQL): a full refund debits the
  credit exactly and returns the balance to zero; a partial refund debits only the returned
  units' share; a line refunded in three visits has its debits sum to the credit (the remainder
  rule); a shop-owned line writes nothing; a refused refund claws nothing back; and a payout
  already made leaves the balance negative rather than blocking the refund. Five more unit tests
  for `clawbackFromLine` in `tests/consignment-rules.test.ts` (now 20).

## Continuation checkpoint

The sale credits and a refund debits; the ledger still has no payout reader. Next is **ticket 06**
(exclude consigned stock from the owned valuation and report it separately), then **07** (refuse a
consigned product offline), **08** (payout with a statement and an audit row — the caller of
`ledgerBalance`/`assertPayable`/`payoutEntry`), **09** (the consignor's own view in the customer
portal).
