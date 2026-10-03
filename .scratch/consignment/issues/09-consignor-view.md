# 09: A consignor sees their own position

**What to build:** A consignor sees the items they have consigned, what has sold, and what is
owed, in the customer portal.

**Blocked by:** 04; and by the customer portal itself (ADR 0020), which did not exist when this
was written. The portal is now built (Effort 2), so this ticket is unblocked.
**Status:** done

- [x] A `member` sees their consigned items, how many have sold, and their current payable.
- [x] The view is scoped to the signed-in customer only — a phone number cannot see another
      consignor's balance.
- [x] A payout appears as a settled statement; a refund appears as a reversal.
- [x] Tests: the figures match the ledger; a second customer cannot read the first's position;
      a customer with nothing consigned sees an empty, styled state.

## Notes

Seeing their own money is what keeps a consignment arrangement out of dispute (ADR 0023), and
it is the same portal ADR 0020 introduces for points and receipts.

## What was built

**The reader.** `src/lib/consignment-portal.ts` — `loadCustomerConsignment(customerId)` returns
the member's whole position in one read: `balanceThb` (the ledger's own sum, via the same
`consignorBalance` the admin's payout screen checks against, so the two numbers cannot differ),
`items` (each consigned product with its agreed share, what is still on the shelf, units sold
across completed orders, units a refund took back, and the net it has earned), and `entries`
(every movement, newest first, with the payout's `payoutId` so a payout reads as a settled
statement). The history window is the newest hundred rows — like the points ledger — but the
balance is read from the *whole* ledger, not that window.

**The route.** `GET /api/v1/consignment` — member-only (`withApi` + `requireRole(['member'])`),
scoped by `session.id`. There is no query parameter naming a consignor, so one member cannot ask
for another's balance by construction.

**The screen.** A **ฝากขาย** tab in the customer portal (`src/components/shop/AccountPortal.tsx`),
beside points, receipts and the phone number. It shows the balance owed, the consigned goods with
their sold/remaining counts, and the movement list (a payout is a `payout` line with a "จ่ายแล้ว"
pill; a refund is a `refund` line). A member who has consigned nothing gets the styled empty
state, not an empty card.

**Tests.** `tests/consignment-portal.test.ts` (4): the figures equal the ledger's; a payout reads
as a settled statement and a refund as a reversal; nothing consigned reads as an empty state; and
a second member cannot read the first's position (and the first is untouched by the attempt).

## Continuation checkpoint

This is the last consignment ticket. The effort's code is complete; the remaining release item is
not code — the accountant's sign-off on principal-versus-agent treatment (ADR 0023).
