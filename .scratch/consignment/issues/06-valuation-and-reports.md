# 06: Consigned stock is not the shop's inventory

**What to build:** Consigned goods are outside the owned stock valuation, and the shop can see
consigned sales, shares owed and consigned stock as their own figures.

**Blocked by:** 01, 04.
**Status:** ready-for-agent

- [ ] The stock valuation at cost excludes consigned products (the shop did not buy them).
- [ ] Reports show consigned stock and shares owed separately from owned figures.
- [ ] The dashboard's figures do not count a consignor's goods as the shop's own.
- [ ] Tests: a consigned product's cost is not in the owned valuation; the consigned figures
      appear separately and sum to the ledger.

## Notes

Filing somebody else's goods under the shop's own inventory is the reporting bug this ticket
exists to prevent (ADR 0023 §7).
