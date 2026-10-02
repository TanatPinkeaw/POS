# 03: Reconcile one identity per sale

**What to build:** Lost responses and repeated sends reconcile one sale, while
refused or unattempted bills stay recoverable and never get skipped.

**Blocked by:** 01, 02.
**Status:** done

- [x] Stable persisted cash-sale identity before transport, shared with replay.
- [x] Concurrent retries settle payment/stock once; incompatible identity reuse refused.
- [x] Sequential bounded batches, backoff, manual override and safe loan closures.
- [x] Keep refused/unattempted bills; recover lost responses/local acknowledgements.
- [x] Preserve original prices/tax/day/drawer and refresh stock without double subtraction.
- [x] Cover concurrent replay, partial failure, ownership and server-commit response loss.

The device persists a cash-sale identity before the first transport attempt and
replays through it, so a duplicate send resolves to one order, one payment and one
stock movement (`src/lib/offline-sales.ts` + `offline-replay` migration). A replay
from the wrong cashier is refused, and incompatible identity reuse is rejected.
The browser journey proves the hard cases against real PostgreSQL: server commit
with a lost response retains the pending identity, a retry records exactly one
order, reconnect sends without a manual click, and a refused bill stays recoverable.
