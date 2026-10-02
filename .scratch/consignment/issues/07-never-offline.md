# 07: A consigned product is never sold offline, and may be pre-ordered

**What to build:** The offline till refuses a consigned product, while the online and
pre-order paths accept it normally.

**Blocked by:** 04.
**Status:** done

- [x] A consigned product is excluded from the offline catalogue snapshot, or its offline sale
      is refused with a typed reason the till shows in Thai.
- [x] The refusal names the next step, not just "offline".
- [x] A consigned product can still be pre-ordered; the share is written at handover (ticket
      04) and the reservation path is unchanged.
- [x] The offline replay never reaches the payable ledger for a consigned product.
- [x] Tests: an offline basket containing a consigned product is refused; a pre-order of one
      succeeds and credits at handover; the replay writes no share.

## Notes

An offline consigned sale would owe a share the device cannot compute or record, so it is
refused by decision, not oversight (ADR 0023 §8). This is the one place consignment and the
offline till meet, and they must not overlap.

## What was built

- **`src/lib/product-view.ts` — the flag the device needs.** `ProductView` gains `isConsigned`,
  derived in `toProductView` from `consignor_user_id` (added to the structural `ProductRow`).
  It is a boolean, not the consignor's identity: presence on the view is not a restriction on
  selling — online sale and pre-order read it nowhere — it exists so the offline rule can tell
  a consignor's goods from the shop's.
- **`src/lib/offline-sale-rules.ts` — the refusal.** `OfflineCatalogueEntry` gains
  `consigned`, `OfflineRefusalCode` gains `'consigned_offline'`, and `collectRefusals` refuses a
  consigned line outright — before the stock check, so the reason is ownership, not quantity.
  The Thai message names the next step: `ต้องต่อเน็ตก่อนขาย เพื่อบันทึกส่วนแบ่งให้ผู้ฝากขาย`.
  A refused sale still burns no number, because every reason is collected before a block moves.
- **`src/components/pos/useTill.ts`.** `remember` copies `product.isConsigned` into the stored
  catalogue entry, and `localProducts` maps it back — so the flag travels with the snapshot the
  device keeps for the outage, and the offline refusal fires on the goods the shop actually has.
- **What was deliberately not done.** Consigned products are *kept* in the snapshot rather than
  filtered out: excluding them would make the till's only answer a generic "not in this device"
  (`product_unknown`) whose advice — fetch the latest list — is impossible offline. Carrying the
  flag lets the refusal name the goods and the real next step.
- **Tests.** `tests/offline-sale-rules.test.ts` (now 29): a consigned line is refused with
  `consigned_offline` and a message that says to connect; a shop-owned line is not refused. A
  `CONSIGNED` fixture was added and `consigned: false` set on the existing ones. New
  `tests/consignment-offline.test.ts` (2, real PostgreSQL): the till's product view marks a
  consignor's goods and not the shop's, and a consigned bill that arrives by the replay path is
  recorded but writes **no** `consignor_payables` row. `tests/till-store.test.ts` fixtures carry
  the flag.

## Continuation checkpoint

Consignment and the offline till no longer overlap. Next is **ticket 08** (the payout: hand the
balance over through the drawer or a transfer, with a statement and an audit row — the caller of
`ledgerBalance`/`assertPayable`/`payoutEntry`), then **09** (the consignor's own view in the
customer portal).

## Known gap

An offline snapshot written **before** this change has no `consigned` field, so a device that
stayed offline across the deploy would treat its consigned products as shop-owned until its next
sync. The field is written on every snapshot save, so the window is one outage; the alternative —
defaulting a missing flag to "refused" — would refuse a shop's whole catalogue on an old
snapshot, which is worse.
