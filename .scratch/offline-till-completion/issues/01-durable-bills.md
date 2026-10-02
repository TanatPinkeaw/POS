# 01: Confirm only durable device bills

**What to build:** A cashier never sees a successful offline sale whose bill and
number usage were not committed to the device. Multiple tabs cannot issue one range.

**Blocked by:** None.
**Status:** done

- [x] Read existing state before checkout; retain it across upgrades.
- [x] Await IndexedDB transaction commit, propagate failures, do not fall back to memory.
- [x] Roll back local tentative state on failed writes; block unsafe further selling.
- [x] Preserve original drawer attribution and serialize device operations.
- [x] Test store behaviour and real Chromium transaction failure/reload/multiple tabs.

## Continuation checkpoint

Closed. `src/lib/offline-db.ts` persists to a durable IndexedDB store and waits on
`transaction.oncomplete` before resolving, so a bill is only reported saved once the
browser has committed it; failures propagate and the store never degrades to an
in-memory fallback. `src/lib/till-store.ts` rolls back tentative local writes on a
failed save and keeps a serial save chain with `storageHealthy` gating further
selling. `acquireTillWriter` takes a native writer lock so only one tab owns the
device. The real-Chromium journey (`npm run offline:browser`) proves, on a
PostgreSQL-backed scratch schema: an aborted transaction never confirms a sale, a
second tab cannot borrow or checkout, a bill beyond the first 60 products persists
before confirmation, and a reload retains the original sale identity.

Verified this session on the current working tree:
`npm run verify` → 61 test files, 920 tests passed; `npm run offline:browser
-- --skip-build` → 21 checks passed; full `npm run verify:all -- --skip-build` → all
5 gates passed in 3m 39s. Changes remain uncommitted.

Source: ../spec.md and ../../../docs/offline-till-spec.md.
