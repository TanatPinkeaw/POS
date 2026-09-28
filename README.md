# POS Realtime · ระบบขายหน้าร้าน สต็อก และพรีออเดอร์ 4 ขั้นตอน

An implementation of `system_requirements_document.md`: a realtime Point-of-Sale
with atomic inventory reservation, a four-phase pre-order lifecycle, RBAC, staff
cash-drawer reconciliation, and loyalty points.

The interface is built on **เหลี่ยมนอก**, this project's own design system: CSS
custom properties for the palette, the density and dark mode, and CSS Modules for
the components — no UI framework, and no CSS framework. Bootstrap's Reboot, the
Hope UI theme the first milestone was built on, and the bridge that re-skinned it
were all removed once the last screen moved across (ADR 0003).

---

## Stack

| Concern | Choice |
| --- | --- |
| Application | Next.js 16 App Router, TypeScript, one process |
| Database | PostgreSQL 17 |
| Data access | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Node | 24 (`.nvmrc`; `engines.node` requires `>=22`) |
| Realtime | Socket.io mounted on the same HTTP server as Next |
| UI | In-house design system (`src/design/` + `src/components/ds/`): CSS custom properties + CSS Modules |
| Auth | bcrypt hashes + `jose`-signed JWT in an httpOnly cookie |
| Tests | Vitest — unit tests plus integration tests against real PostgreSQL |

### Why one process

`next dev` cannot host a second listener, so `src/server.ts` starts Next
programmatically and attaches Socket.io to the same `http.Server`. One origin
means the browser sends the session cookie to both the pages and the websocket,
and there is no proxy to configure. The websocket then needs no separate
authentication scheme.

---

## What is *not* vendored

There is no theme. The screens are drawn by `src/design/` and
`src/components/ds/`, so the Hope UI tree that the first milestone copied into
`public/hope-ui/` was deleted in phase 5 of the migration, together with the
`--bs-*` bridge in `tokens.css`, the `globals.css` that patched up what the bridge
could not reach, and Bootstrap's JavaScript. Three consequences, each a
choice rather than an accident:

- **Bootstrap is not a dependency, and never was one to install.** The vendored
  stylesheet bundled its own compiled copy; nothing pulls it in now.
  `npm run ui:audit` fails if a Bootstrap class name, a `data-bs-*` attribute or a
  `/hope-ui/` reference reappears in `src/`, because the failure it guards is
  silent: the markup still compiles and the screen merely renders unstyled. That
  is not hypothetical — it happened once during the migration.
- **No icon or chart package either.** `src/components/ds/icons.ts` is a
  hand-written 24×24 stroke set, and `src/components/ds/Chart.tsx` draws the one
  chart the dashboard needs, which is why `apexcharts` is not installed.
- **Some behaviour had to be written rather than configured.** The vendored
  `hope-ui.js` was jQuery-based and initialised on `DOMContentLoaded`, which Next
  cannot promise for a client-rendered page, so the user menu became
  `src/components/ds/Menu.tsx` — with `aria-haspopup`/`aria-expanded`, arrow-key
  movement, Home/End and Escape-to-close, none of which the original had. Dark
  mode is a `dark` class on `<body>`, resolved on the server from a cookie so
  there is no white flash, and it is the design tokens that key off it.

---

## The design system: เหลี่ยมนอก

The product is **เหลี่ยมนอก** (Liam Nong — "the square outside", the corner that
came off the box). The name belongs to the **platform chrome**: sign-in, the
setup wizard, the sidebar, the error pages. It never appears on a receipt, a
reprint or a customer-facing page — those carry the *renter's* brand, which is
what `shops` exists for (ADR 0002).

```
src/brand/          brand.ts (names, copy, mark geometry) · BrandMark · Wordmark
src/design/         tokens.css · base.css · brand-page.module.css
src/components/ds/  the component library screens are migrating onto
```

Three decisions are worth knowing before changing anything here:

- **Colour is generated, not typed.** `src/brand/brand.ts` holds one seed; the
  50–900 ramp and the neutral ramp are derived from it into a marked block of
  `src/design/tokens.css`. Change the seed, run `npm run brand:palette`, and the
  whole product re-brands, because no screen hardcodes a colour.
- **The icons are ours.** `src/components/ds/icons.ts` is a hand-written 24×24
  stroke set. The previous arrangement used text glyphs (`☰`, `☾`) and emoji,
  which render differently on Windows, iOS and Android.
- **The fonts are self-hosted.** `next/font` downloads Inter and Noto Sans Thai at
  build time and serves them from this origin. The old build `@import`ed Google
  Fonts on every page load, so a shop with flaky internet got fallback glyphs for
  Thai text — a till that mis-renders its own language is not a cosmetic problem.

| Command | What it does |
| --- | --- |
| `npm run brand:palette` | Regenerates the ramp from the seed. `-- --check` fails if stale. |
| `npm run brand:icons` | Rasterises the mark into the PNG/ICO app icons. `-- --preview` prints them as text. |
| `npm run ui:audit` | Fails if the retired theme reappears in `src/` — a Bootstrap class, a `data-bs-*` attribute, a `/hope-ui/` reference. |
| `npm run route:audit` | Builds, serves, and opens all 16 screens: each must render, land where it should, and have every class on it defined by the CSS that page loads, with nothing fetched from another origin. |
| `npm run bank:bridge` | Reads the shop's own bank notifications and closes the bills they pay. `-- --file <eml>` shows what it would post, without a mailbox. |
| `npm run verify` | `typecheck` + `ui:audit` + palette-up-to-date + `test`. |

The migration is **finished**: every one of the 16 routes is on the design system
and the vendored theme is gone — no Bootstrap classes, no Bootstrap JavaScript, no
`--bs-*` variables, nothing left to restyle. `npm run ui:audit` asserts that rather
than assuming it, which is what makes the removal an event instead of a hope.

`npm run route:audit` asserts the other half of the same claim, the half a source
scan cannot see: that each route's rendered markup is actually *styled* by the CSS
it loads. A stylesheet that stops being imported, or one that begins pulling a font
from a CDN, compiles and type-checks perfectly and ships an unstyled screen — which
is not hypothetical here, because exactly that survived the theme removal until
this check was written. All of it runs in CI on every push.

---

## Getting started

### 1. Install

Needs a running PostgreSQL 17 server. On Windows:

```bash
winget install --id PostgreSQL.PostgreSQL.17 --exact
```

Then, from the project root, one command does the rest:

```bash
npm install
npm run setup
```

`npm run setup` writes `.env` with a generated database password and session
secret, creates the role `pos_app` and both databases, and applies every
migration. It asks for your PostgreSQL **superuser** password, uses it, and never
stores it. It is idempotent, so running it twice is safe.

**It installs no demo data, on purpose.** A shop that is about to trade must not
start with 30 fake products, so the demo seed is opt-in *and* refuses to run once
a shop exists — `npm run db:seed:demo` is the explicit override, for a throwaway
database only.

The equivalent by hand is to create the role and both databases as the superuser,
`cp .env.example .env`, and then `npm run db:setup`.

`DATABASE_URL`, `TEST_DATABASE_URL`, and `AUTH_SECRET` are the three settings that
matter. Tests **refuse to run** unless the test database name contains `test`,
because they truncate tables.

### 2. First run — the setup wizard

```bash
npm run dev             # http://localhost:3000
```

No shop exists yet, so every path leads to **`/setup`**: shop name, branch, VAT
registration and rate, tax id, receipt prefix, and the first administrator. It
closes permanently afterwards — a second attempt is refused with a 409, and the
singleton primary key on `shops` is what makes that true even when two requests
race. The whole journey, from an empty schema to a printed VAT receipt, is
asserted by `npm run acceptance` below.

The operator's runbook — checklist before opening the till, the import template,
backups, password recovery — is `docs/renter-onboarding.md`.

### 3. Or use the demo data instead

On a **throwaway** database only:

```bash
npm run db:seed:demo
```

| Role | Phone |
| --- | --- |
| Admin (ผู้จัดการ) | `0800000001` |
| Employee — cashier | `0800000002` |
| Employee — stock | `0800000003` |
| Member | `0900000001` |

The password for all of them is `password123`. The roster, categories and 30
products the seed creates are what `npm run smoke` drives.

---

## Verifying it works

```bash
npm run typecheck       # tsc --noEmit
npm run ui:audit        # the retired theme stays retired
npm test                # 512 tests across 35 files: unit + integration
npm run smoke           # 42 end-to-end checks over real HTTP (needs npm run dev)
npm run acceptance      # 82 checks of the whole renter journey, from an empty schema
npm run route:audit     # all 16 screens render, and render styled
npm run bank:bridge     # the shop's own bank notifications, in and out of the till
```

`npm run acceptance` is the one that proves an *installation* works, which the
smoke test structurally cannot: its personas are seeded accounts, so it
presupposes the demo data. Acceptance drops a private PostgreSQL schema
(`accept`), migrates it empty, serves the production build against it, and drives
the setup wizard's API, the staff API, a catalogue spreadsheet and a VAT sale —
asserting that `net + VAT === gross` to the satang, that the first receipt takes
the renter's own series (`FR-<year>-000001`), that a reprint matches the sale
exactly, and that the demo seed now *refuses* to touch the configured shop.

`npm run route:audit` covers the other blind spot. Acceptance never reads a byte
of HTML, so a screen whose module was renamed, whose stylesheet was never imported,
or that quietly began fetching a font from another origin passes all 82 of its
checks. So this one builds, serves, sets up a shop the way a renter would, opens
every screen with the session that screen needs, and compares the markup against
the CSS that came back with it.

It is a Node script rather than curl and bash, and that is worth recording: on
Windows, Thai text in a `curl -d` argument is re-encoded through the console
codepage (the shop name arrived as `??????????`), and a mingw `curl -F
file=@/tmp/x.csv` cannot open a Git Bash path at all. Both produced empty
responses that looked exactly like server bugs, and the previous acceptance run
was misread because of it — the application was right and the harness was lying.

`npm test` covers, among other things:

- **No overselling.** 50 concurrent reservations against 20 units of stock:
  exactly 20 succeed, 30 are rejected with a 409, and `reserved_qty` lands on
  exactly 20. Repeated for multi-unit requests and for a cart that lists the same
  product twice.
- **The full lifecycle**, phase by phase, asserting the two stock counters and
  the point ledger at each step.
- **The Phase 1 timeout**, including that a confirmed order is never expired.
- **Cash settlement**, including that PromptPay is excluded from the drawer
  reconcile.
- **Attendance**, including that `work_hours` is computed by PostgreSQL, that the
  roster is joined to the day the shift actually started, and that a second open
  log is impossible even when the application guard is bypassed.
- **Reversing a paid sale**, including that a second refund is refused by the
  database as well as by the state machine, that money cannot leave the till with
  no credit note behind it, that clawing back points never blocks a customer's
  refund, and that the dashboard's cash figure nets what was handed back.
- **Money arriving from a bank notification**, including the refusals: an amount
  matching a bill but naming none, two candidates for one amount, money that
  arrives after the QR was withdrawn, and a bridge retrying the same message.
- **The day's transfers against the bills they closed**, including that a satang
  is a difference, that a payment waiting longer than its own QR was valid is
  named, and that a QR transfer stops being flagged the moment its bill is rung up.

`npm run smoke` drives the running server as a browser would — logging in as all
three roles, placing a pre-order, confirming it, collecting it with a PIN,
reconciling the drawer, downloading all four SRS §8 workbooks (asserting the
xlsx content type, the ZIP magic bytes, and that a cashier is refused), and then
clocking the cashier in and out against the roster.

### Reports and exports (SRS §8)

`GET /api/v1/reports/export?type={report_type}&from={date}&to={date}` returns one
`.xlsx` attachment per call. `type` is one of `sales_summary`,
`product_performance`, `employee_attendance`, `stock_audit`; `from`/`to` are
`YYYY-MM-DD` calendar days interpreted in Asia/Bangkok and default to the
trailing 30 days. The endpoint is **admin-only** and, being the single binary
response in the app, bypasses the JSON envelope on success while still returning
the usual `{ error }` shape on failure.

Each workbook has one sheet whose row-1 headers are the SRS §8 column names
verbatim. Money is written as numbers (so a column sums in Excel) and timestamps
as Bangkok strings formatted without `Intl`, so an export is byte-stable across
hosts. The admin screen at `/admin/reports` picks the type and date range and
shows the exact columns before downloading.

`employee_attendance` reads `time_logs.work_hours` through a raw query, because
that column is a stored generated column Prisma cannot model. It is populated by
the scheduling and attendance feature below.

### Staff scheduling and attendance (SRS §6)

The manager rostered two employees in the seed, so the demo timesheet is not
empty; rosters upsert on `(employee, day)`.

- **`/admin/schedules`** — write a shift (employee, day, `HH:MM`–`HH:MM`), browse
  the roster, and read the timesheet for any date range. Two admin-only actions
  live here: back-filling a shift nobody clocked, and removing a row entered in
  error.
- **`/pos/attendance`** — the staff time clock: one button, plus the day's roster,
  hours so far, and every log for the day.

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/attendance/current` | staff | own day: open log, roster, hours |
| `POST /api/v1/attendance/check-in` | staff | clock on |
| `POST /api/v1/attendance/check-out` | staff | clock off (returns `work_hours`) |
| `GET /api/v1/attendance` | admin | timesheet for a date range |
| `POST /api/v1/attendance/manual` | admin | back-fill or correct a row |
| `DELETE /api/v1/attendance/{id}` | admin | remove a mistaken row |
| `GET` / `POST /api/v1/schedules` | admin | read the roster; upsert one shift |
| `DELETE /api/v1/schedules/{id}` | admin | un-roster a shift |

Wall-clock times are stored as `date`/`time` columns rather than instants — a
shift is a statement about the clock on the wall, so "09:00" must not mean
different hours in different timezones. Lateness and overtime are then pure
functions of the actual check-in against the rostered window, shared verbatim
with the §8 export so the screen and the workbook can never disagree.

An employee can never clock in for someone else: the route always uses the
caller's own id, and back-filling somebody else's shift is a separate admin-only
endpoint that says so.

---

## How the SRS maps onto the code

| SRS | Where |
| --- | --- |
| §7 schema | `prisma/schema.prisma` + `prisma/migrations/.../migration.sql` |
| §4.1–4.2 atomic stock | `src/lib/inventory.ts` — one conditional `UPDATE` per mutation |
| §4.3 adjustment audit | `adjustStock()` + `stock_logs` |
| §3 four phases | `src/lib/orders.ts`, pure machine in `src/lib/order-state.ts` |
| §5 loyalty | `src/lib/loyalty.ts` (pure) + `src/lib/points.ts` (ledger) |
| §6 scheduling & attendance | `src/lib/attendance.ts` (persistence), `bangkok-time.ts` + `attendance-rules.ts` (pure) |
| §6.2 cash drawer | `src/lib/shifts.ts` (pure) + `src/lib/cash-shifts.ts` (persistence) |
| §8 Excel exports | `src/lib/reports.ts` (queries) + `src/lib/report-spec.ts` (columns/formatting) + `src/lib/excel.ts` (rendering) |
| §2 RBAC | `src/lib/roles.ts`, enforced in `src/proxy.ts` **and** every route handler |
| Reversal of a paid sale (beyond the SRS) | `src/lib/credit-notes.ts` (the transaction) + `src/lib/order-state.ts` (the `refund` edge) — ADR 0004 |

The domain rules are split into **pure functions** (loyalty, settlement, the
state machine, the discrepancy formula) and **persistence** modules. That split
is why 319 of the 512 tests need no database at all, and why the money rules can
be checked without a running server.

---

## Shop identity, VAT, and the renter's own setup

The SRS has no shop identity and no tax concept at all — receipts, page titles
and the tax rate were hardcoded — so this is the largest *addition* to it. See
`docs/adr/0002-shop-identity-and-vat.md` for the reasoning and the tradeoffs.

| Surface | What it is for |
| --- | --- |
| `/setup` + `POST /api/v1/setup` | The wizard: shop, VAT and the first administrator, written in one transaction. Refuses with 409 once a shop exists. |
| `/admin/settings` | Shop name, branch, tax id, VAT registration and rate, inclusive vs exclusive pricing, receipt prefix and footer, plus the **next receipt number**. |
| `/admin/staff` | Staff accounts, created from the app rather than from SQL. The last administrator cannot be deactivated. |
| `/admin/products` → categories | Categories are createable at last, and deleting one that still has products is refused by the database. |
| `/admin/products` → import | CSV or `.xlsx` catalogue import: a preview that writes nothing, a downloadable template, and its own `REASON_IMPORT` audit entries. |
| `GET /api/v1/orders/{id}/receipt` | Reprint data, read from the order's own snapshot columns, so a 2026 receipt still shows 7% in 2027. |
| `POST /api/v1/orders/{id}/refund` | Reverse a whole paid bill and issue a credit note. Supervisor PIN required, always. |
| `GET /api/v1/orders/{id}/credit-note` | Reprint data for that credit note — the sibling of the receipt route. |
| `POST /api/v1/payments/inbound` | A bank notification, from the shop's own bridge. Machine-only, shared secret. |
| `GET /api/v1/payments/inbound` | Money the bank reported that could not be matched to a bill. Admin-only. |
| `/admin/dashboard` → เงินโอนเข้าวันนี้ | Confirmed vs closed transfers for the day, the awaiting-collection list, and the unmatched list. |

Two database-enforced invariants carry most of the weight:

- `CHECK (net_amount + vat_amount = final_amount)` — a tax receipt whose lines do
  not add up is refused by the database, not by a code review.
- `CHECK (id = 1)` on `shops` — the singleton is a fact, so a racing second setup
  cannot win one.

Money is `DECIMAL(10,2)`; tax arithmetic is done in integer satang
(`src/lib/vat.ts`), because a breakdown off by one satang is a document that does
not balance rather than a rounding nit.

**This is not a compliance certification.** The receipt layout follows the usual
Thai retail format, but whether it satisfies the Revenue Department is the shop's
accountant's call. What the software *does* now provide is the paper trail that
question turns on: see below.

### Reversing a paid sale — credit notes

The SRS has no void, refund or credit-note concept anywhere, and a gapless receipt
series with no way to reverse one is a gap a tax-invoice-issuing shop cannot live
with. `docs/adr/0004-credit-notes-and-refunds.md` is the decision; this is what it
means in practice.

**One credit note per receipt, for the whole bill.** Not per line and not for a
free-form amount: an amount that matches no bill is a document that proves
nothing, and a tax invoice is reversed by a credit note that names it in full. A
receipt therefore has at most one credit note (`UNIQUE (order_id)`), and
`refunded` is a terminal order status — a second refund has nowhere to go, and
the database refuses it even if two requests race past the state machine.

**The number comes from the shop's own series.** `shops.credit_note_prefix` and
`shops.credit_note_running_number` mirror the receipt columns, allocated in the
transaction that writes the note, so a credit-note series is as gapless as the
receipt series it reverses — and a refused refund burns no number. It is a
*separate* series: `CN-2026-000001` does not consume `FR-2026-000042`.

**Money only leaves in one of two ways**, and the credit note records which:

- **Out of an open drawer.** The refund writes a `payments` row with
  `direction = 'refund'` against the current shift, which *reduces* that drawer's
expected cash — the cashier counting at close finds the money already accounted
  for rather than a mystery shortage. With no drawer open the refund is refused
  with `NO_OPEN_SHIFT`, exactly as a cash sale would be.
- **By hand in the banking app.** The leg carries no `shift_id` at all, because
  it never touched a till. Writing it against a shift would invent a discrepancy
  for money that no cashier handled.

No refund is ever *sent* automatically: pushing money back out needs bank API
onboarding, which is the shop's decision and its paperwork, not a feature flag.

**Money is stored positive and signed by `direction`.** `payments` keeps
`CHECK (amount > 0)`, so a refund leg is not a negative row; it is a positive row
whose direction says which way the money went. Every aggregate then has to decide
what it means, and it cannot do so by accident — which is the point. Cash in the
drawer nets refunds; gross takings do not, because a bill paid on Monday and
refunded on Friday belongs in Monday's takings *and* in Friday's refunds.

**Stock comes back through the same primitives.** Every unit on the bill returns
to `stock_qty` (never to a reservation — a refunded sale's goods go on the shelf)
as a `pos_refund` stock movement, so the SRS §4.3 adjustment log explains it in
its own words. Points are reversed too, and **clamped**: a customer who has
already spent the points their purchase earned does not have their refund blocked
by a negative balance. The unclawable remainder is recorded on the note as
`points_forgiven` rather than silently dropped.

The whole reversal is audited as `refund_order`, naming the cashier who was at
the till and the supervisor whose PIN allowed it — the same shape as a staff
cancel. Rewriting the original receipt is never an option: its number is already
in somebody's hands, so the credit note is a second document that references it.

### Confirming a transfer automatically, for nothing

A customer pays by PromptPay and the bill should close itself. The honest position
is that this system cannot know money arrived — only a bank can — so the question
is who carries the fact from the bank to the till. The usual answer is a payment
provider or a bank API; both cost money per check or per month, and both ask the
shop to sign up for something before the first transfer can close a bill.
`docs/adr/0005-automatic-transfer-confirmation.md` is the decision; the short
version is that the shop's own bank notification does the carrying.

```bash
npm run bank:bridge -- --file ./notification.eml   # what would be posted
npm run bank:bridge -- --once                     # one pass over the mailbox
npm run bank:bridge -- --interval 60              # keep watching
```

The bridge reads a mailbox the bank already emails, extracts the amount with the
shop's own pattern, and posts the notification to `/api/v1/payments/inbound` with
the message's own id and the bank's own timestamp. Everything about *reading* mail
is pure and unit-tested (`src/lib/bank-mail.ts`); everything about *deciding* which
bill the money paid is pure and unit-tested too (`src/lib/inbound-match.ts`); what
is left in the script is a socket and a loop.

**The matcher never guesses.** It requires the amount to match a QR exactly — in
satang — and then requires the notification to name that QR's reference as a
whole token. An amount on its own is refused even when exactly one QR is open,
because two customers in one queue can owe the same ฿107.00 and "there was only
one" is a fact about the moment rather than about the transfer. Money that arrives
after the QR was withdrawn is refused; so is money for a bill that was already
closed, which is what a retrying bridge sends the second time.

**Nothing is dropped, and nothing is invented.** Every notification is recorded in
`inbound_payments` — matched or not, with the reason it could not be attributed,
and with `NULL` rather than a fabricated number when the amount could not be read
at all. An amount of zero or one satang in the place where a real amount belongs
is the one thing that table must never contain. Whatever is left unattributed
appears on the dashboard, and an admin can close it with a reason (audited as
`inbound_transfer_dismissed`) when it turns out not to be a sale of ours. The same
bank message is recorded once, enforced by `UNIQUE (source, external_id)` rather
than by the bridge's own bookkeeping.

**Refunds are never sent this way.** Money leaves through the open drawer or by
hand in the shop's banking app, and the credit note says which. Automating a payout
needs bank API onboarding and an authority this system should not hold: a bug in a
matcher that closes a bill is a bill closed wrongly, while a bug in one that pays
out is money gone.

**And the day adds up in one place.** Every transfer leaves two traces — the bank's
confirmation and the bill that closed — and the dashboard compares them: confirmed,
closed, and the difference with both of its normal explanations (a transfer
confirmed by hand at the till, or money that arrived and was never rung up).
Beneath it are the two lists that make it actionable: payments the bank confirmed
that no bill has closed (the expensive one — the customer has paid and no receipt
exists), and money that could not be matched to anything at all. Where the figures
disagree, the screen says which side is larger; nothing here claims to know why.

---

## Deliberate deviations and additions

See `docs/adr/0001-schema-deviations-from-srs.md` (the schema) and
`docs/adr/0002-shop-identity-and-vat.md` (shop, tax, receipts) for the reasoning.
In short:

- `gen_random_uuid()` instead of the `uuid-ossp` extension — same result, one
  fewer extension, built into PostgreSQL 13+.
- `stock_logs.reason` added. SRS §4.3 mandates an adjustment-reason enum
  (`REASON_RESTOCK` etc.) that §7's DDL never declares a column for.
- `orders.pickup_expires_at` added. SRS §3 Phase 3 mandates a holding-time
  limit with no column to store it.
- A `payments` row per payment leg rather than one `mixed` row, so that
  `SUM(amount) WHERE method = 'cash'` is exactly the physical cash in the drawer.
- A seeded, inactive `SYSTEM_USER_ID` account owns system-driven stock
  movements, because `stock_logs.changed_by` is `NOT NULL`. Weakening that
  constraint to accommodate automation would have cost the audit trail.
- The route guard lives in `src/proxy.ts` exporting `proxy()`, which is the
  Next 16 replacement for the deprecated `middleware.ts` convention.

## Licence

**Proprietary — all rights reserved.** See `LICENSE`. This is software a shop runs
and owns rather than open source: copying it, redistributing it and offering it as
a hosted service are all reserved to the copyright holder. Commercial licensing
goes through them.

## Documentation

| Document | What it is |
| --- | --- |
| `system_requirements_document.md` | The specification this implements. |
| `docs/renter-onboarding.md` | The operator's runbook: install, the wizard, the daily routine, backups, recovery. |
| `docs/adr/0001-schema-deviations-from-srs.md` | Every place the database departs from SRS §7, and why. |
| `docs/adr/0002-shop-identity-and-vat.md` | Shop identity, VAT and gapless receipt numbering — a requirement the SRS never states. |
| `docs/adr/0004-credit-notes-and-refunds.md` | Reversing a paid sale: the credit-note series, the refund leg, and why money is signed by direction. |
| `docs/adr/0005-automatic-transfer-confirmation.md` | Closing a bill from the shop's own bank notification, and why the matcher refuses when it is not certain. |
| `docs/wongnai-pos-gap-analysis.md` | Where this stands against a commercial Thai POS, and the build order that follows. |

## Not built yet

Deferred deliberately, and listed here rather than discovered during service:

- **Partial refunds and per-line returns.** A refund reverses the whole bill
  (ADR 0004 decision 2). Returning one line of a three-line sale, or refunding
  only part of what was paid, is not expressible yet — and doing it properly
  means the credit note stops mirroring its invoice and starts *itemising* the
  part it reverses.
- **Overtime approval and leave.** Attendance is recorded and measured, but there
  is no request/approve workflow on top of it, and no leave calendar.
- **Pickup QR codes.** SRS §3 asks for a PIN *and* a QR; only the PIN exists, and
  the `qrcode` dependency is installed and unused.
- **Outbound notifications.** Alerts are in-app and Web Notifications only, so a
  customer who closes the page hears nothing.
- **Multi-branch and a second register.** One shop per deployment, and receipt
  issuance serialises on the shop row (ADR 0002 §4) — correct for one till.
- **Product images and a shop logo.** `products.image_url` and `shops.logo_url`
  exist; there is no upload and no storage.
- **Production hardening:** rate limiting, an audit-log viewer, RTL, and object
  storage.
- **A reconciliation screen over a date range.** The dashboard reconciles *today*:
  what the bank confirmed against what closed a bill, with the transfers left
  over. Comparing a week or a month against a statement is still two screens.
