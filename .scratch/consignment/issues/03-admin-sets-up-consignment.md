# 03: An admin consigns a product, and withdraws it

**What to build:** An admin can put a product into consignment with a member and a percentage,
change the terms, and withdraw unsold goods — each an audited act.

**Blocked by:** 01.
**Status:** done

- [x] Set `consignor_user_id` and `consignor_share_percent` at `/admin/products`, admin-only.
- [x] A consignor must be an existing `member`; a product already sold cannot change owner.
- [x] Withdrawing unsold goods is a stock adjustment with an SRS §4.3 movement and an audit
      row — never a silent delete.
- [x] Changing the percent is audited with the old and new value.
- [x] Tests: a non-member is refused; a change after a sale is refused or recorded, per the
      decision taken while building; withdrawal writes the movement.

## Notes

Only an admin, because goods belonging to somebody else inside the shop is a liability
(ADR 0023 §1). The screen reuses the existing product admin surface.

## Continuation checkpoint

**The decision, taken while building.** Owner changes are **refused** once the product has any
order line (`setConsignment` counts `order_items`); a share change **with the same member** is
allowed and audited with the old and new value. The reasoning: the share is read at the moment
of sale (ticket 04), so a product that changed hands after a sale would make "who did we owe for
that line" a question with two answers — but the terms themselves are a bargain, and re-agreeing
them is exactly what the trail is for.

**One library, two trail rows.** `src/lib/consignment.ts` holds `setConsignment` and
`withdrawConsignment`, both taking a `Db` so their writes join the caller's transaction.
`setConsignment` refuses a consignor who is not a `member`, writes both columns together (the
migration's CHECK refuses the half-state anyway), and records `consignment_set` with the previous
values alongside the new ones. `withdrawConsignment` removes the unsold physical stock through
`adjustStock` — so the shelf change is an SRS §4.3 `manual_adjust`/`REASON_CORRECTION` row, not a
silent edit — then clears the owner and records `consignment_withdrawn` with the units that left.
It refuses a product that is not consigned, and refuses one that has been sold (the goods are the
customer's and the shop still owes the share).

**Two new audit actions, and the surface.** `consignment_set` and `consignment_withdrawn` were
added to the `audit_action` enum (migration `20260121000000_consignment_audit_actions`) and to
`audit-view.ts` with Thai labels and tones. The route is
`/api/v1/products/[id]/consignment` — `PATCH` re-agrees the terms, `POST` withdraws, both
admin-only. `/admin/products` gains a `ฝากขาย` column and a dialog that finds the member through
the existing till lookup (`GET /api/v1/members?search=`), and the page loads the consignor's name
with the product.

**Tests.** `tests/consignment-admin.test.ts` (9) against real PostgreSQL: the member and share
round-trip with the trail's detail; a non-member and a non-existent id are refused and nothing is
written; the same member's share can be re-agreed and the old value is recorded; the owner cannot
change after a sale; withdrawal writes the movement and clears the liability; a non-consigned
product and a sold one are both refused.
