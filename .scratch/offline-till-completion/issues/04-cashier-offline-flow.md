# 04: Prepare, sell and send from the counter

**What to build:** Cashiers prepare offline explicitly, search/scan cached goods,
sell cash, view local tickets, send automatically or manually and safely close a drawer.

**Blocked by:** 02, 03.
**Status:** done

- [x] Thai readiness/freeze/cache age/number capacity/pending/result UI using the design system.
- [x] Local cached search/category/barcode and device queue; no cold offline launch promise.
- [x] Reconnect sending with bounded retries and cleaned-up timers/listeners.
- [x] Unsupported offline actions are refused with actionable Thai copy.
- [x] Send all bills and release loans before normal shift close.
- [x] Admin recovery of stranded loans requires actual printed-number evidence.
- [x] Ordinary online shop flows remain intact.

`src/components/pos/Till.tsx` and `src/components/pos/useTill.ts` give the cashier an
explicit "เตรียมเครื่องขายออฟไลน์" preparation step with a device name and a freeze
warning, a cached catalogue that stays searchable and scannable, an in-device queue
with ready/collected state, automatic reconnect sending (10s) plus a manual "ส่งบิล
ตอนนี้", and a "ส่งบิลและคืนชุดเลข" action before close. Unsupported offline paths —
members, points, preorders, PromptPay, refunds, over-limit discounts — are refused
with actionable Thai copy. Admin recovery lives in
`src/components/admin/NumberLoanRecovery.tsx` and demands the actual printed-number
range before it will free a loan.
