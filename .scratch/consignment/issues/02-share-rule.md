# 02: The pure rule for a consignor's share

**What to build:** One pure module that says how much of a consigned sale the shop owes, and
how a refund and a payout move that balance.

**Blocked by:** None.
**Status:** done

- [x] `shareFromSale(netExclVatThb, percent)` → the consignor's share in satang, rounded, with
      the remainder belonging to the shop.
- [x] The rule reads the **net, excluding VAT**, never the gross — VAT is the state's.
- [x] The refund reversal and the payout arithmetic as pure functions over a ledger.
- [x] Unit tests: the arithmetic, the rounding boundary (a satang lands on the shop), and that
      a payout may not exceed the balance.

## Notes

Pure, in the spirit of `refund-plan.ts` and `offline-sale-rules.ts` — the money rule tested
without a server. The two write sites (ticket 04) both call it, so there is one answer.

## Continuation checkpoint

**One module, `src/lib/consignment-rules.ts`, and no I/O in it.** `shareFromSale(netExclVatThb,
percent)` works in integer satang (`toSatang`), so the multiply-and-round happens off the float:
`Math.round((netSatang * percent) / 100)` back through `fromSatang`. The rounding is the point —
฿100.01 at 33% is ฿33.0033, the consignor takes ฿33.00, and the extra satang is the shop's, so
the parts always add back up to the net. A non-positive net earns nothing; a percent outside
0–100 throws a Thai `ValidationError` rather than silently clamping. The rule reads net
**excluding VAT** and is named for it, because VAT is the state's, not the consignor's.

**Refund, payout and balance are the same pennies moved the other way.**
`refundReversal(shareThb)` is the negation, so refunding the whole sale nets the ledger to
zero. `payoutEntry(amountThb)` is likewise a debit. `ledgerBalance(amountsThb[])` sums signed
movements (satang again) and **tolerates a negative** — a refund after the shop has already
paid out is a real debt to recover on the next payout, not something to clamp to zero.
`assertPayable(balanceThb, amountThb)` is the guard a payout route calls: positive, and never
more than the balance, each refusal a Thai `ValidationError`.

**Tests are the spec.** `tests/consignment-rules.test.ts` (11 tests) covers the percentage, the
satang remainder, never exceeding the net, the non-positive and out-of-range edges, the
refund-to-zero clawback, the payout debit and signed sum, the tolerated negative balance, and
the payout guard's exact / over / non-positive cases. Ticket 04 calls `shareFromSale` at both
sale sites, so this is where the one answer to "what do we owe" is pinned down.
