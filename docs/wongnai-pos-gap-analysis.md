# Where this system stands against Wongnai POS

**Written:** 2026-09-27 · **Updated:** 2026-09-28 (§4.1 closed by ADR 0004)
**Compared:** this repository (SRS + implementation) against Wongnai POS
(LINE MAN Wongnai).

**Confidence marks used below.** `[C]` = stated on the vendor's own product page,
fetched 2026-09-27 · `[I]` = inferred from a stated feature · `[U]` = unverified,
listed explicitly in §5 rather than guessed at. Everything about *our* column is
read from this repository, not from memory.

---

## 0. The recommendation in one line

Our pre-order and inventory core is stronger than theirs, and the one gap that
stopped a VAT-registered shop from being served end to end — **a reversed sale with
no credit-note document behind it** — is closed (§4.1, ADR 0004). What is left at
the top of the list is the notification channel, which is parity rather than
correctness.

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
| **Void / refund / credit note** | ✅ | ✅ `[C]` | whole-bill and per-line refunds + gapless `CN` series; no free-form amount |
| QR payment generate + verify at the till | ✅ | ✅ `[C]` | amount locked into the QR, and the bill closes itself from the shop's own bank notification — no PSP, no per-check fee (ADR 0005). Needs the shop's bank to send notification email |
| Split bill per seat | ➖ | ✅ `[C]` | a restaurant concept |
| Loyalty points | ✅ | `[U]` | accrued and redeemed with a ledger |

### Orders and channels

| Capability | Ours | Them | Note |
| --- | --- | --- | --- |
| Walk-in sale | ✅ | ✅ | |
| **Pre-order that reserves stock at placement** | ✅✅ | ⚠️ `[C]` | theirs takes pre-orders; ours locks the units in the statement that sells them, so a reservation cannot oversell |
| Four-phase lifecycle with auto-expiry | ✅ | ❌ | ours only |
| Partial confirmation (drop a line, release its stock) | ✅ | ❌ | ours only |
| 4-digit pickup PIN + hold deadline | ✅ | `[U]` | |
| **Pickup QR code** | ✅ | ✅ `[C]` | SRS asks for PIN **and** QR; both now, side by side on the customer's order (ADR 0006) |
| **Outbound customer notification** | ✅ | ✅ `[C]` | an outbox written with the order, sent by a worker the shop runs — LINE for the shop, SMS/webhook for the customer (ADR 0007) |

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
6. **An incoming transfer closes its own bill for nothing.** The shop's bank
   already emails when money arrives, so the fact is carried by something the shop
   owns rather than by a payment provider's per-check service — and when the
   notification cannot be matched to a bill, the money is still recorded and shown
   instead of being guessed at or dropped (ADR 0005).

---

## 4. Where we are behind, in the order it matters

### 4.1 Void / refund and credit notes — **closed**

Built. Receipt numbers never repeat and never skip, an order can be cancelled, and
a **paid** bill can now be reversed with a credit-note document behind it — which
is the thing a tax-invoice-issuing shop actually needs. `docs/adr/0004-credit-notes-and-refunds.md`
is the decision record.

What landed, against the shape predicted here: a `credit_notes` table with its own
gapless series (`UNIQUE (order_id)`, so one note per receipt and a second refund
is impossible even under a race); a ``refund`` edge out of ``completed`` and a
terminal ``refunded`` status; one money leg, positive, with
`payments.direction = 'refund'` rather than a negative amount (the
`CHECK (amount > 0)` that made this a schema decision is still true); stock
returned through `returnRefundedStock` as a `pos_refund` movement, so §4.3's
adjustment log explains it; a supervisor PIN bound to the order id; and a
reprintable document that names the invoice it reverses.

Two things did **not** come out the way this section first guessed, and both are
worth recording:

- **The money does not have to come out of a drawer.** Writing the leg against the
  open shift is right when cash is handed over at the counter, and that path
  refuses with `NO_OPEN_SHIFT` when nothing is open. But a shop that transfers the
  money back from its banking app would have had a false shortage recorded against
  a cashier who never touched it, so a refund leg may instead carry no `shift_id`
  at all, and the credit note says which of the two happened.
- **The refund itemises, and a bill takes several notes.** Per-line and per-quantity
  reversals land in ADR 0008: the note records the lines going back, the closing note
  is defined by subtraction so the notes foot to the invoice to the satang, and a
  partly credited invoice keeps its own totals. What is still absent is a **free-form
  amount** — a refund that names no line — and that is deliberate rather than pending,
  because an amount matching no line is a document that proves nothing.

Remaining, and small: no automatic *outbound* refund, because pushing money back
needs bank API onboarding rather than code.

### 4.2 Notification the customer can actually receive — done

Our in-app socket alert only reached somebody with the page open; theirs pushes
through LINE. Both halves now exist: the customer's collection code goes to their
phone on a webhook channel, and the shop gets a note about a new pre-order on LINE
or by SMS — written in the same transaction as the order, retried on a schedule,
and abandoned visibly when a gateway is misconfigured (ADR 0007).

What is still missing is the *routing* rather than the delivery: `line` can only
address the shop's own group, because a LINE user id is not something this system
captures from a customer. Members would need to hand one over, which is a consent
question before it is a schema one.

### 4.3 Pickup QR — done

SRS §3 asks for PIN *and* QR. Both are now on the customer's order screen: a
signed code that expires with the hold and names exactly one parcel, plus the PIN
underneath it for the phone that has died. The till's one handover box takes
either — it routes on the shape of what arrives (`src/lib/pickup-scan.ts`) — and
the collection board seen by the queue deliberately carries neither.

### 4.3a A shop cannot create a customer — closed by ADR 0010

Found while wiring the acceptance run against §4.3, and it was the sharpest kind of
hole: `/api/v1/members` was a read-only lookup and `/api/v1/staff` made only
employees and admins, so a freshly installed shop had **no way to create a member** —
while a pre-order requires `requireRole(['member'])`. SRS §2 is a member-facing
ordering path, so the absence blocked the feature it existed for, and the only
workaround was a developer running SQL.

Closed by `/admin/members` and `POST /api/v1/members` (ADR 0010): a manager types a
name, a phone number and a temporary password, and the customer signs in with it.
What it deliberately did *not* take is the branch this section first suggested —
member self-registration with an OTP — because that needs a messaging account, a
consent story and an unpaid attacker's playground of fake accounts, while a shop that
already knows the customer can hand them a credential in ten seconds.

The counter is covered as well (ADR 0011): `/pos` carries *สมัครสมาชิกใหม่* beside the
member search, and it opens the same enrolment as a dialog over the bill — so a
cashier adds the customer in front of them without losing a half-rung basket, and the
customer lands on that bill when it closes. `POST /api/v1/members` is now
`['employee', 'admin']`; editing an account stayed admin-only, because adding one is a
counter act and changing how one signs in is not.

### 4.4 A till that survives a flaky connection — **closed**

Done, and further than the shape this section first proposed. ADR 0019 built the part
that was called "a much bigger promise and should be a separate decision" — a full
offline sales queue with number loans and stock reconciliation, refusing in the
operator's own words rather than failing silently. ADR 0024 closed the rest: a prepared
till keeps its own shell, so it opens with no connection at all, and the drawer is the
one thing it may answer from memory — from a prepared device only, and labelled as read
from the machine. The API is never cached; a route the device did not prepare gets an
honest "no connection" page. What remains unbuilt is named in README's *Not built yet*:
offline PromptPay/member/refund, a second register, and RSC payloads.

### 4.5 Multi-branch and a second register — growth

Both are closed off by ADR 0002 decision 1 (singleton shop) and decision 4
(serialised receipt allocation). Neither is hard, but each is a schema decision
rather than a screen, so it belongs before the shop needs it, not after.

### 4.6 Images, and the rest of the polish list

Product images and a shop logo (columns exist, no upload), RTL, object storage.
Cheap, visible, and each unlocks perceived quality. The audit-log viewer and the rate
limiter are done (ADRs 0009 and the trail screen), and the limiter's buckets moved out
of the process and into the shop's own database (ADR 0012), so a restart no longer
forgives an attacker. What is left inside the limiter is what its known gaps say:
nothing bounds the table from above, and a distributed attacker is the reverse proxy's
problem rather than this module's.

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

1. ~~**Void / refund + credit notes** (§4.1)~~ — **done**, ADRs 0004 and 0008. The
   only item on this list where *not* building it means a shop cannot legally
   trade. Per-line refunds closed the last correctness gap: a customer returning
   one item out of three is served at the counter.
2. ~~**Notification outbox with a real channel** (§4.2)~~ — **done**, ADR 0007.
   Messages are written with the fact that produced them and sent by a worker the
   shop runs, so half of the pre-order feature — "the customer finds out" — no
   longer depends on somebody looking at a screen.
3. ~~**Pickup QR** (§4.3)~~ — **done**, ADR 0006, and the gap it surfaced is closed
   too: **a shop can create a member** (§4.3a, ADR 0010) — from the back office and,
   since ADR 0011, from the till itself. The thread is finished: the pre-order the QR
   collects can be placed by somebody the shop enrolled, and the enrolling can happen
   where the customer is standing.

**Then the things that keep a growing shop:**

4. ~~**Offline-tolerant till** (§4.4)~~ — **done**, ADR 0019 and ADR 0024: a prepared
   till keeps selling cash with no connection, including from a cold start.
5. **Product images and shop logo** (§4.6) — small, visible, makes the catalogue
   feel real.
6. **Second register at one shop** (ADR 0002 §4) — revisit before a shop buys a
   second till, not after.
7. **Multi-branch** (ADR 0002 §1) — a schema decision; do it once a renter asks.

**Competitive parity, which follows demand rather than correctness:**

8. ~~**QR payment generation and verification at the till**~~ — **done** without a
   PSP: the QR is generated at the till, the bill is closed from the shop's own
   bank notification (ADR 0005), and the dashboard reconciles the day — what the
   bank confirmed against what closed a bill, with the payments that closed
   nothing called out. What is left here is a range rather than a day, for a
   statement that covers a week or a month.
9. ~~**Audit-log viewer plus rate limiting**~~ — **done**. The trail screen reads
   every action back with its people and its details, and the limiter counts
   attempts on the five doors that need no session (ADR 0009). What it does not
   do is scale past one process, which is the right size for one shop.
10. **Kitchen/table features** — only if we decide to serve food service. Today
    that is a different product, and chasing it would cost us the stock and
    pre-order advantages.

---

## 7. Re-evaluation triggers

- A renter issues its first tax invoice → item 1 moves from "soon" to "now".
- A renter asks for a second branch or a second till → items 6 and 7.
- A customer misses a pickup because they were not told → item 2.
- Network outages start costing sales → item 4 (done; a cold launch is what was left).
- We decide to serve restaurants → re-read §2 in its entirety, because half of the
  ➖ entries become ❌.
- Wongnai changes its pricing or ships a stock-reservation model → re-fetch and
  re-mark §5.
