# 01: Store who consigned a product, and what the shop owes

**What to build:** A product can belong to a consignor with an agreed share, and the shop
keeps a ledger of what it owes them.

**Blocked by:** None.
**Status:** done

- [x] `products.consignor_user_id` (nullable) and `products.consignor_share_percent`, with a
      CHECK that a consigned product's percent is 0–100 and that both are set together.
- [x] `consignor_payables` ledger: one row per movement (credit from a sale, debit from a
      refund or a payout) naming the consignor, the order/line it came from, and its kind.
- [x] A migration, applied and reversible the way the existing migrations are.
- [x] Regenerate the Prisma client and commit it, as the repository requires.
- [x] A regression test: a consigned product round-trips its owner and percent; an invalid
      percent is refused by the database, not only by the application.

## Notes

The ledger shape mirrors `point_transactions`: an append-only list summed for a balance, never
a column that can drift. Ownership on `products` reuses `stock_qty`, the oversell guard and
the safety quantity untouched (ADR 0023 §2).

## Continuation checkpoint

**Ownership on the product, enforced in the database.** `products.consignor_user_id` is a
nullable `Uuid` with an FK to `users` (`ON DELETE RESTRICT` — a member who still consigns goods
cannot be deleted out from under their payables), and `products.consignor_share_percent` is a
nullable `Int`. Two CHECKs in migration `20260120000000_consignment_owner_and_ledger` carry the
invariant the application also states: `chk_products_consignor_pair` (the owner and the percent
move together — one set without the other is not a state), and `chk_products_consignor_share`
(0–100). An index on `consignor_user_id` answers "what does this member consign".

**The ledger, signed by kind.** `consignor_payables` is one append-only row per movement
(`id` BigInt, `consignor_user_id`, `kind` of the new enum `consignor_payable_kind`
{sale, refund, payout}, `amount_thb` `Decimal(10,2)` **signed**, optional `order_id` /
`order_item_id` / `product_id` / `description`, `created_at`). `chk_consignor_payables_sign`
is the direction rule: a `sale` is ≥ 0 (a credit the shop owes), a `refund` or `payout` is
≤ 0 (a debit against it). The order/line/product FKs are `ON DELETE SET NULL` so a removed
order leaves the ledger intact rather than erasing a debt; only the consignor FK restricts.

**The test proves the database refuses, not just the app.** `tests/consignment-schema.test.ts`
(6 tests) round-trips an owner and share, and asserts PostgreSQL itself rejects a partial pair,
an out-of-range percent, and a debit written as a `sale` (or credit as a `payout`) — the last
one through Prisma surfacing the `23514` check violation. `tests/helpers/test-db.ts` gained
`consignor_payables` in its truncation list.
