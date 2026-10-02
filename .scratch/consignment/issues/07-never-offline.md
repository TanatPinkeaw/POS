# 07: A consigned product is never sold offline, and may be pre-ordered

**What to build:** The offline till refuses a consigned product, while the online and
pre-order paths accept it normally.

**Blocked by:** 04.
**Status:** ready-for-agent

- [ ] A consigned product is excluded from the offline catalogue snapshot, or its offline sale
      is refused with a typed reason the till shows in Thai.
- [ ] The refusal names the next step, not just "offline".
- [ ] A consigned product can still be pre-ordered; the share is written at handover (ticket
      04) and the reservation path is unchanged.
- [ ] The offline replay never reaches the payable ledger for a consigned product.
- [ ] Tests: an offline basket containing a consigned product is refused; a pre-order of one
      succeeds and credits at handover; the replay writes no share.

## Notes

An offline consigned sale would owe a share the device cannot compute or record, so it is
refused by decision, not oversight (ADR 0023 §8). This is the one place consignment and the
offline till meet, and they must not overlap.
