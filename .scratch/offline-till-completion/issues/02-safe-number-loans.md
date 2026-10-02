# 02: Prepare and release number loans safely

**What to build:** An explicitly prepared cashier device owns recoverable loans;
today and tomorrow remain separate daily series and invoices remain contiguous.

**Blocked by:** 01.
**Status:** done

- [x] Stable reservation identity survives lost responses without adopting other loans.
- [x] Today/tomorrow reserve, claim, report and cancel work against real PostgreSQL.
- [x] Receipt claims cannot skip a number; unsafe year-boundary use is refused.
- [x] Respect ownership and lock ordering; unused loans can be released safely.
- [x] Do not expose preparation to the cashier before replay is ready.

Loan rows carry the device label and kind, are keyed by a stable reservation id, and
a lost borrow response recovers the same loan rather than adopting another device's.
`src/lib/number-blocks.ts` and `src/lib/shop.ts` keep the queue counter and receipt
prefix contiguous from history and refuse an unsafe year-boundary use. Ownership is
enforced on the recovery route (`/admin/offline-number-loans/[id]`) and by
`offline-sales.ts` on replay. Normal shift close sends all bills and releases every
loan; the journey asserts the release. Verified by the number-blocks, device-numbers,
sync-plan and offline-replay suites plus the browser journey's "normal close releases
all number loans" check.
