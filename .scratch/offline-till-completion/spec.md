# Offline till completion

Status: done

Authoritative specification: [offline till](../../docs/offline-till-spec.md).
Decision: [ADR 0019](../../docs/adr/0019-the-till-sells-offline.md).

## Approved completion scope

Explicit cashier preparation while online; durable bills before confirmation;
exclusive device writer; today's/tomorrow's borrowed numbers; idempotent sequential
replay; local catalogue search/scan and queue; reconnect/manual sending; send all
bills and release loans before normal shift close. Preserve shops that never opt in.
No cold offline app launch, service worker, offline customer data or non-cash sale.

## Test seams

Existing till-store interface with injected storage/transport, server persistence
against real PostgreSQL, and actual Chromium/IndexedDB using Playwright (dev only).
A transport error is uncertain, not evidence that a request never committed.
Storage failure must not confirm a sale or fall back silently to volatile memory.
Concurrent retries write one bill/payment/stock movement. Refusal stops the prefix;
unattempted bills and unclosed loans remain recoverable. Queue daily counters must
survive reserving tomorrow before today ends. Original shift attribution is immutable.

## Delivery

Tickets 01–05 are worked blockers-first, red/green slices and Standards/Spec review.
Existing uncommitted replay work is preserved and reviewed, not staged or committed.
Final release gates include the new browser journey and match CI. Document remaining
proof gaps honestly; no production migration/deploy or automatic Git commit.
