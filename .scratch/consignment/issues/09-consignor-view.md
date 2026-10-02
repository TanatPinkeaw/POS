# 09: A consignor sees their own position

**What to build:** A consignor sees the items they have consigned, what has sold, and what is
owed, in the customer portal.

**Blocked by:** 04; and by the customer portal itself (ADR 0020), which does not exist yet.
**Status:** ready-for-agent

- [ ] A `member` sees their consigned items, how many have sold, and their current payable.
- [ ] The view is scoped to the signed-in customer only — a phone number cannot see another
      consignor's balance.
- [ ] A payout appears as a settled statement; a refund appears as a reversal.
- [ ] Tests: the figures match the ledger; a second customer cannot read the first's position;
      a customer with nothing consigned sees an empty, styled state.

## Notes

Seeing their own money is what keeps a consignment arrangement out of dispute (ADR 0023), and
it is the same portal ADR 0020 introduces for points and receipts. This ticket can only be
worked once that portal exists, which is a genuine dependency rather than a preference.
