# 05: A refund claws the share back

**What to build:** Refunding a consigned sale debits the consignor's payable by the share the
sale credited.

**Blocked by:** 04.
**Status:** ready-for-agent

- [ ] A refund of a consigned line writes a `consignor_payables` debit for the same share.
- [ ] A partial refund debits only the returned quantity's share.
- [ ] A debit that leaves a negative balance is carried forward and netted by the next payout,
      rather than blocking the refund.
- [ ] Tests: refund after sale → balance returns to zero; partial refund → the exact share;
      refund after a payout → negative carried, next payout nets it.

## Notes

The goods go back to the consignor, so the share goes with them (ADR 0023 §6). Follows the
existing refund transaction (ADRs 0004, 0008); the points clawback is the precedent for a
balance that may go negative without blocking the customer.
