# 08: Pay a consignor, with a statement

**What to build:** An admin settles what the shop owes a consignor, by drawer or transfer,
leaving a statement and an audit row.

**Blocked by:** 04.
**Status:** ready-for-agent

- [ ] A payout debits the ledger by the amount paid and cannot exceed the balance owed.
- [ ] Money leaves only through an open drawer or the shop's own banking app, recorded the way
      a refund leg already is — never an automatic transfer.
- [ ] A payout produces a **statement** (the sales it covers and the amount) and an audit row.
- [ ] If a payout is recorded with no drawer open, it is refused as a cash refund would be.
- [ ] Tests: a payout nets the balance to zero; an over-payment is refused; a payout with no
      drawer open is refused; the statement and the ledger agree.

## Notes

Money leaving the till already has a rule (ADR 0004): out of an open drawer, or by hand in the
banking app. A payout follows it, and the statement is what turns a number into an agreed
settlement. A Thai shop pays by transfer, so the transfer leg is the common case.
