# 04: Record the share in the sale's own transaction

**What to build:** Every consigned sale writes one payable credit, in the same transaction
that writes the money, at both places a sale completes.

**Blocked by:** 01, 02.
**Status:** ready-for-agent

- [ ] `createPosSale` writes a `consignor_payables` credit for each consigned line.
- [ ] `completeOrder` (a pre-order handover) writes the same credit — the second site.
- [ ] The share is computed by the pure rule (ticket 02) from the line's net excluding VAT.
- [ ] A sale that rolls back owes nobody: no credit exists without a committed sale.
- [ ] Tests: one credit per consigned line; none for a shop-owned line; none when the
      transaction rolls back; a pre-order handover credits at handover, not at placement.

## Notes

Two write sites are the integration point to watch in review; a shared helper both call keeps
them from drifting. This is the same "the database is what makes it true" shape the rest of
the money path uses: the credit is written with the sale, not after it.
