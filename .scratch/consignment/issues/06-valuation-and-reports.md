# 06: Consigned stock is not the shop's inventory

**What to build:** Consigned goods are outside the owned stock valuation, and the shop can see
consigned sales, shares owed and consigned stock as their own figures.

**Blocked by:** 01, 04.
**Status:** done

- [x] The stock valuation at cost excludes consigned products (the shop did not buy them).
- [x] Reports show consigned stock and shares owed separately from owned figures.
- [x] The dashboard's figures do not count a consignor's goods as the shop's own.
- [x] Tests: a consigned product's cost is not in the owned valuation; the consigned figures
      appear separately and sum to the ledger.

## Notes

Filing somebody else's goods under the shop's own inventory is the reporting bug this ticket
exists to prevent (ADR 0023 §7).

## What was built

- **`src/lib/analytics.ts` — the shelf is split by owner.** The product read now carries
  `consignor_user_id`, and the snapshot partitions the active rows into owned and consigned.
  `catalogue.stockValueAtCostThb` sums **only the owned rows** (same per-product floor at zero
  as before, so a replayed offline sale cannot make the figure negative); `catalogue` gains
  `ownedProducts` for the card's caption. A new `consignment` block reports, separately:
  `productCount`, `units`, `stockValueAtCostThb` (the consignor's goods, summed by the same
  rule as the owned figure so the two are comparable) and `sharesOwedThb`.
- **`sharesOwedThb` is the ledger's own sum.** A `consignor_payables` aggregate, not a cached
  column — the same arithmetic `ledgerBalance` does — so the dashboard figure is the rows it
  claims to be and cannot drift.
- **`src/app/(admin)/admin/dashboard/page.tsx`.** The stock card is relabelled
  **"มูลค่าสต็อกของร้าน (ทุน)"** and captioned with the owned product count; a separate
  **"สินค้าฝากขาย"** card carries the consigned products, units, value at cost and shares owed.
  It appears only when the shop has a consignment to show, and says in its subtitle that these
  figures are outside the shop's own.
- **Tests.** `tests/consignment-valuation.test.ts` (3, real PostgreSQL): a consigned product's
  cost stays out of the owned valuation and appears in the consignment block instead; the
  shares-owed figure equals the ledger's own sum and follows it as a sale and then a partial
  refund move the balance; and with nothing consigned every product counts as owned and the
  consignment block is all zeros.

## Decision recorded

The four Excel workbooks are a fixed SRS §8 contract (pinned by `tests/reports.test.ts` as
"exactly the four reports"), so the consignor dimension lives in the reporting snapshot
(`analytics.ts`) that the dashboard renders, rather than becoming a fifth workbook. If an owner
needs a downloadable consignor sheet, that is a new report type and a separate decision.

## Continuation checkpoint

The ledger is written and now read back for reporting; it still has no payout reader. Next is
**ticket 07** (refuse a consigned product offline — the device snapshot does not carry a
consignor), then **08** (payout with a statement and an audit row, the caller of
`ledgerBalance`/`assertPayable`/`payoutEntry`) and **09** (the consignor's own view in the
customer portal).
