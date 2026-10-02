# 01: Store who consigned a product, and what the shop owes

**What to build:** A product can belong to a consignor with an agreed share, and the shop
keeps a ledger of what it owes them.

**Blocked by:** None.
**Status:** ready-for-agent

- [ ] `products.consignor_user_id` (nullable) and `products.consignor_share_percent`, with a
      CHECK that a consigned product's percent is 0–100 and that both are set together.
- [ ] `consignor_payables` ledger: one row per movement (credit from a sale, debit from a
      refund or a payout) naming the consignor, the order/line it came from, and its kind.
- [ ] A migration, applied and reversible the way the existing migrations are.
- [ ] Regenerate the Prisma client and commit it, as the repository requires.
- [ ] A regression test: a consigned product round-trips its owner and percent; an invalid
      percent is refused by the database, not only by the application.

## Notes

The ledger shape mirrors `point_transactions`: an append-only list summed for a balance, never
a column that can drift. Ownership on `products` reuses `stock_qty`, the oversell guard and
the safety quantity untouched (ADR 0023 §2).
