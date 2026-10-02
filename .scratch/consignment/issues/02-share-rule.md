# 02: The pure rule for a consignor's share

**What to build:** One pure module that says how much of a consigned sale the shop owes, and
how a refund and a payout move that balance.

**Blocked by:** None.
**Status:** ready-for-agent

- [ ] `shareFromSale(netExclVatThb, percent)` → the consignor's share in satang, rounded, with
      the remainder belonging to the shop.
- [ ] The rule reads the **net, excluding VAT**, never the gross — VAT is the state's.
- [ ] The refund reversal and the payout arithmetic as pure functions over a ledger.
- [ ] Unit tests: the arithmetic, the rounding boundary (a satang lands on the shop), and that
      a payout may not exceed the balance.

## Notes

Pure, in the spirit of `refund-plan.ts` and `offline-sale-rules.ts` — the money rule tested
without a server. The two write sites (ticket 04) both call it, so there is one answer.
