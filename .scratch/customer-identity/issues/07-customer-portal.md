# 07: The customer portal

**What to build:** A signed-in customer sees their points, their receipts, and can change
their phone.

**Blocked by:** 02, 03, 06. (And ticket 06's renderer, 05.)
**Status:** ready-for-agent

- [ ] Extends `/shop/*` (no new Area): points history, the last month's receipts, and a phone
      change that requires the OTP of ticket 03.
- [ ] Scoped to the signed-in customer: a second customer cannot read the first's points or
      receipts.
- [ ] Empty states are styled, not blank, for a customer who has not bought anything.
- [ ] The screen is reachable by `member` under the matrix of ticket 04 and by no other role.
- [ ] Tests: the figures match the ledgers; another customer's data is unreachable; the phone
      change goes through the OTP refusal path; a customer with no orders sees the empty state.

## Notes

The consignment view (`.scratch/consignment/issue 09`) hangs off this portal — a consignor
seeing what is owed is the same screen family.
