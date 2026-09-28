# Where this system stands against Wongnai POS

**Written:** 2026-09-27
**Compared:** this repository (SRS + implementation) against Wongnai POS
(LINE MAN Wongnai).

**Confidence marks used below.** `[C]` = stated on the vendor's own product page,
fetched 2026-09-27 · `[I]` = inferred from a stated feature · `[U]` = unverified,
listed explicitly in §5 rather than guessed at. Everything about *our* column is
read from this repository, not from memory.

---

## 0. The recommendation in one line

Our pre-order and inventory core is stronger than theirs, but a VAT-registered
shop cannot be served end to end yet, because **a cancelled tax invoice has no
credit-note document**. Fix void/refund before any competitive feature work; it is
a correctness gap, not a feature gap.

---

## 1. These are not direct competitors

| | This system | Wongnai POS |
| --- | --- | --- |
| Domain | retail / minimart, barcode-driven | restaurants, table + kitchen |
| Centre of gravity | reservation integrity, pickup handover, stock truth | order taking, kitchen routing, table management |
| Platform | web app, self-hosted, one process | Android/iPad app on their hardware |
| Business model | software the shop owns and runs | subscription plus hardware plus support |
| Cost | the hardware you already have | a monthly fee per branch `[C]` |

**Positioning consequence:** do not chase tables, kitchen displays or queue
numbers. Win on stock correctness, pickup logistics, and being self-hosted (a shop
that does not want its sales data in somebody else's cloud).

---

## 2. Feature matrix

✅ at or better · ⚠️ partial · ❌ absent · ➖ out of domain by design

### Checkout and payments

| Capability | Ours | Them | Note |
| --- | --- | --- | --- |
| Barcode scan → cart → cash → change | ✅ | ✅ | `PosTerminal.tsx`, `settlement.ts` |
| Cash / PromptPay / points / split | ✅ | ✅ | one `payments` row per leg, so the drawer reconciles exactly |
| Manual discount | ✅ | ✅ `[C]` | |
| Receipt print and reprint | ✅ | ✅ `[C]` | reprint reads the order's own snapshot columns |
| **VAT on the receipt** | ✅ | `[U]` | derived out of the shelf price, rate snapshotted per sale |
| **Gapless receipt numbering** | ✅ | `[U]` | column bumped in-transaction, so a rollback cannot burn a number |
| **Void / refund / credit note** | ❌ | ✅ `[C]` | **our largest gap — §4.1** |
| QR payment generate + verify at the till | ❌ | ✅ `[C]` | theirs locks and verifies the bill amount |
| Split bill per seat | ➖ | ✅ `[C]` | a restaurant concept |
| Loyalty points | ✅ | `[U]` | accrued and redeemed with a ledger |

### Orders and channels

| Capability | Ours | Them | Note |
| --- | --- | --- | --- |
| Walk-in sale | ✅ | ✅ | |
| **Pre-order that reserves stock at placement** | ✅✅ | ⚠️ `[C]` | theirs takes pre-orders; ours locks the units, and `chk_stock_availability` makes overselling impossible |
| Four-phase lifecycle with auto-expiry | ✅ | ❌ | ours only |
| Partial confirmation (drop a line, release its stock) | ✅ | ❌ | ours only |
| 4-digit pickup PIN + hold deadline | ✅ | `[U]` | |
| **Pickup QR code** | ❌ | ✅ `[C]` | SRS asks for PIN **and** QR; only the PIN exists (the `qrcode` dependency is installed and unused) |
| **Outbound customer notification** | ❌ | ✅ `[C]` | ours is in-app + Web Notifications only |

### Back office

| Capability | Ours | Them | Note |
| --- | --- | --- | --- |
| Shop identity + VAT settings | ✅ | ✅ | ours arrived late; see ADR 0002 |
| Staff accounts and roles | ✅ | ✅ `[C]` | three roles; last admin cannot be deactivated |
| Roster, time clock, lateness/overtime | ✅ | ✅ `[C]` | computed by PostgreSQL from the actual check-in |
| Cash-drawer open/close with reconciliation | ✅ | ✅ `[C]` | expected vs counted, named as short/over/balanced |
| Excel reports | ✅ | ✅ `[C]` | four SRS §8 workbooks, admin-only |
| Catalogue bulk import (CSV/XLSX) | ✅ | ✅ `[C]` | preview that writes nothing, then an atomic commit |
| Stock audit trail with reasons | ✅ | `[U]` | `stock_logs.reason`, `REASON_IMPORT` for imports |
| **Multi-branch** | ❌ | ✅ `[C]` | one shop per deployment by design |
| **Second register at one shop** | ⚠️ | ✅ | receipt issuance serialises on the shop row (ADR 0002 §4) |
| Supplier / purchase orders | ❌ | `[U]` | stock arrives by import or adjustment |
| Product images | ❌ | ✅ `[C]` | column exists, no upload |

### Platform

| Capability | Ours | Them | Note |
| --- | --- | --- | --- |
| Realtime updates to other screens | ✅ | `[U]` | Socket.io on the same listener, cookie-authenticated |
| Installable app / offline tolerance | ❌ | ✅ | the till needs its network; planned |
| Audit-log viewer for admins | ❌ | `[U]` | the data is written, the screen is not built |

---

## 3. Where we are genuinely ahead

1. **Stock cannot be oversold.** Reservation is a conditional single-statement
   `UPDATE`, plus `CHECK (stock_qty >= reserved_qty)`. Fifty concurrent
   reservations against twenty units produce exactly twenty wins — asserted, not
   asserted-by-eye.
2. **The pre-order lifecycle is a real state machine** with a partial-confirmation
   path theirs does not document.
3. **The tax arithmetic is exact and auditable**: integer satang, rate snapshotted
   per sale, and `CHECK (net_amount + vat_amount = final_amount)` so the database
   refuses a receipt that does not balance.
4. **Self-hosted.** No subscription, no per-branch fee, and the shop's sales data
   stays on the shop's machine.
5. **The whole renter journey is acceptance-tested** from an empty schema
   (`npm run acceptance`), which is a fact about the software nobody can claim
   from a feature list.

---

## 4. Where we are behind, in the order it matters

### 4.1 Void / refund and credit notes — correctness

Today: receipt numbers never repeat and never skip, and an order can be cancelled
— but there is **no credit-note document** for a cancelled VAT invoice, and the
original number is correctly never reused. A shop that has issued tax invoices has
no compliant way to reverse one. This is why it ranks above every feature.

Shape of the fix: a `credit_notes` table with its own gapless series, a refund
that writes negative payment legs against the *open* drawer (or refuses if none is
open), stock returned through `adjustStock` with its own reason, and a reprintable
document that references the original receipt number.

### 4.2 Notification the customer can actually receive — parity

Our in-app socket alert only reaches somebody with the page open. Theirs pushes
through LINE. For a pre-order shop this is the difference between a customer
knowing their order is ready and a customer standing outside. Shape: a
notification outbox table with a pluggable channel (LINE Notify / SMS), retried,
with the in-app path staying as the fallback.

### 4.3 Pickup QR — already specified, not built

SRS §3 asks for PIN *and* QR; `qrcode` is already a dependency and unused. Small,
self-contained, and it shortens handover.

### 4.4 A till that survives a flaky connection — operational risk

Network loss currently means no sales. Theirs is an installed app. Shape: install
the PWA, cache the app shell and the last catalogue snapshot, and make the offline
state *explicit* (refuse the checkout with a clear message rather than failing
silently). A full offline sales queue with stock reconciliation is a much bigger
promise and should be a separate decision.

### 4.5 Multi-branch and a second register — growth

Both are closed off by ADR 0002 decision 1 (singleton shop) and decision 4
(serialised receipt allocation). Neither is hard, but each is a schema decision
rather than a screen, so it belongs before the shop needs it, not after.

### 4.6 Images, and the rest of the polish list

Product images and a shop logo (columns exist, no upload), an audit-log viewer,
rate limiting. Cheap, visible, and each unlocks perceived quality.

---

## 5. What I could not verify about Wongnai POS

Stated here rather than implied anywhere above:

- **Pricing tiers, hardware bundles and support levels** — the vendor page states
  a monthly range and 24/7 support `[C]`, but what each tier contains `[U]`.
- **Whether their receipts are legally-sufficient tax invoices**, and whether they
  number them gaplessly `[U]`. Their marketing claims a "POS Pay" QR flow, not a
  tax document.
- **Whether pre-orders on their platform reserve stock** `[C]` mentions pre-orders
  through LINE MINI Eats; whether inventory is locked at placement `[U]`.
- **Whether they provide roster/attendance at all** `[U]`.
- **Their export column sets** `[C]` mentions "reports"; the columns `[U]`.
- Their page is marketing, and marketing ages. Treat `[C]` as "true as of
  2026-09-27" and re-check before making a decision on it.

---

## 6. Recommended build order

**Correctness first — this is not discretionary:**

1. **Void / refund + credit notes** (§4.1). The only item on this list where
   *not* building it means a shop cannot legally trade.
2. **Notification outbox with a real channel** (§4.2). Half of the pre-order
   feature is "the customer finds out", and today they do not.
3. **Pickup QR** (§4.3). Already in the SRS, already a dependency, small.

**Then the things that keep a growing shop:**

4. **Offline-tolerant till** (§4.4) — app-shell caching plus an explicit offline
   state. Argue separately about a sales queue.
5. **Product images and shop logo** (§4.6) — small, visible, makes the catalogue
   feel real.
6. **Second register at one shop** (ADR 0002 §4) — revisit before a shop buys a
   second till, not after.
7. **Multi-branch** (ADR 0002 §1) — a schema decision; do it once a renter asks.

**Competitive parity, which follows demand rather than correctness:**

8. **QR payment generation and verification at the till** — needs a PSP
   relationship, so it is not purely a coding task.
9. **Audit-log viewer plus rate limiting** — hardening; do it before exposing the
   till to a public network.
10. **Kitchen/table features** — only if we decide to serve food service. Today
    that is a different product, and chasing it would cost us the stock and
    pre-order advantages.

---

## 7. Re-evaluation triggers

- A renter issues its first tax invoice → item 1 moves from "soon" to "now".
- A renter asks for a second branch or a second till → items 6 and 7.
- A customer misses a pickup because they were not told → item 2.
- Network outages start costing sales → item 4.
- We decide to serve restaurants → re-read §2 in its entirety, because half of the
  ➖ entries become ❌.
- Wongnai changes its pricing or ships a stock-reservation model → re-fetch and
  re-mark §5.
