# 05: Prove the offline journey and document its limits

**What to build:** The release gate and CI exercise real browser offline selling;
operator documents describe the behaviour that actually ships.

**Blocked by:** 04.
**Status:** done

- [x] Playwright Chromium plus PostgreSQL scratch-schema journey and device-storage tests.
- [x] Extend acceptance and align CI with verify:all, reusing one production build.
- [x] Run focused tests, typecheck and all release gates on the final working tree.
- [x] Review rendered UI and Standards/Spec, report environment blockers honestly.
- [x] Update product/spec/ADR/runbook and measured counts without claiming shop-field proof.
- [x] Preserve original work and leave changes uncommitted.

`scripts/offline-browser.ts` (Playwright, dev-only, Chromium + IndexedDB against a
real PostgreSQL scratch schema) adds the browser journey; `verify:all` runs it as its
fifth gate after `verify → acceptance → route:audit → limiter:race`, sharing one
production build and matching `.github/workflows/verify.yml`. Measured on the current
working tree: `verify` 61 files / 920 tests; `acceptance` 140 checks; `route:audit`
23 passed / 0 failed; `limiter:race` passed; `offline:browser` 21 checks; the full
`npm run verify:all` green in 4m 08s (a follow-up review pass split the offline replay's
merged `REPLAY_BILL_MALFORMED` refusal into `REPLAY_CASH_SHORT` / `REPLAY_DISCOUNT_OVER_LIMIT`). CI has not been observed running
on the host; that remains an honest gap. All changes stay uncommitted.
