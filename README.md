# POS Realtime · ระบบขายหน้าร้าน สต็อก และพรีออเดอร์ 4 ขั้นตอน

An implementation of `system_requirements_document.md`: a realtime Point-of-Sale
with atomic inventory reservation, a four-phase pre-order lifecycle, RBAC, staff
cash-drawer reconciliation, and loyalty points.

The interface is built on **[Hope UI](https://github.com/iqonicdesignofficial/hope-ui-html-admin-dashboard)**
(Bootstrap 5, MIT), vendored into `public/hope-ui/`.

---

## Stack

| Concern | Choice |
| --- | --- |
| Application | Next.js 16 App Router, TypeScript, one process |
| Database | PostgreSQL 17 |
| Data access | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Realtime | Socket.io mounted on the same HTTP server as Next |
| UI | Hope UI (Bootstrap 5) + ApexCharts |
| Auth | bcrypt hashes + `jose`-signed JWT in an httpOnly cookie |
| Tests | Vitest — unit tests plus integration tests against real PostgreSQL |

### Why one process

`next dev` cannot host a second listener, so `src/server.ts` starts Next
programmatically and attaches Socket.io to the same `http.Server`. One origin
means the browser sends the session cookie to both the pages and the websocket,
and there is no proxy to configure. The websocket then needs no separate
authentication scheme.

---

## The theme: what is vendored, and why so little

Hope UI has no npm package, so its compiled assets are copied into
`public/hope-ui/`. Only the files the app actually loads are committed — 2.6 MB
rather than the 18 MB upstream tree:

```
public/hope-ui/
├── LICENSE
└── assets/
    ├── css/core/libs.min.css     Bootstrap + vendor CSS
    ├── css/custom.min.css        Hope UI's custom layer
    ├── css/dark.min.css          every rule scoped under `.dark`
    ├── css/hope-ui.min.css       the design system (already contains Bootstrap 5)
    ├── js/core/libs.min.js       Bootstrap's JS (dropdowns, collapses, modals)
    └── images/                   favicon.ico, loader.gif
```

Two things this implies:

- **Do not install Bootstrap from npm as well.** `hope-ui.min.css` already
  bundles a compiled Bootstrap 5; a second copy would conflict.
- `loader.gif` is kept even though nothing renders it, because
  `hope-ui.min.css` references it. The unused demo imagery (avatars, auth
  backgrounds, icon sets — about 15 MB) was deliberately left out; re-fetch it
  from the upstream repo if a future screen needs it:

  ```bash
  git clone --depth 1 \
    https://github.com/iqonicdesignofficial/hope-ui-html-admin-dashboard.git \
    /tmp/hope-ui && cp -r /tmp/hope-ui/dist/assets/images/* \
    public/hope-ui/assets/images/
  ```

Hope UI's own `hope-ui.js` is **not** vendored either. It is jQuery-based and
initialises on `DOMContentLoaded`, which Next cannot guarantee for a
client-hydrated page, so the handful of behaviours it provided are implemented
in React instead — the sidebar collapse is a `sidebar-mini` class toggle in
`src/components/hope/AppShell.tsx`, and dark mode is a `.dark` class on
`<body>`, resolved on the server from a cookie so there is no white flash.
`hope-ui.min.css` sets `--bs-body-bg` on `body` itself, so putting the class on
`<html>` left `body` painting a light background over the dark one.

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
  whole product re-brands — including the four Hope UI variables that re-skin
  every screen that has not been migrated yet.
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
| `npm run verify` | `typecheck` + palette-up-to-date + `test`. |

The migration is **in progress and deliberately incremental**: sign-in is on the
design system today, the rest of the screens still run on the vendored Hope UI
classes with the brand bridge applied. Both look like the same product while it
happens, so there is no half-restyled phase to live through. When the last screen
moves, the Hope UI assets, the Bootstrap JS and the bridge all go in one commit.

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
npm test                # 184 tests across 14 files: unit + integration
npm run smoke           # 42 end-to-end checks over real HTTP (needs npm run dev)
npm run acceptance      # 48 checks of the whole renter journey, from an empty schema
```

`npm run acceptance` is the one that proves an *installation* works, which the
smoke test structurally cannot: its personas are seeded accounts, so it
presupposes the demo data. Acceptance drops a private PostgreSQL schema
(`accept`), migrates it empty, serves the production build against it, and drives
the setup wizard's API, the staff API, a catalogue spreadsheet and a VAT sale —
asserting that `net + VAT === gross` to the satang, that the first receipt takes
the renter's own series (`FR-<year>-000001`), that a reprint matches the sale
exactly, and that the demo seed now *refuses* to touch the configured shop.

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

The domain rules are split into **pure functions** (loyalty, settlement, the
state machine, the discrepancy formula) and **persistence** modules. That split
is why 40 of the tests need no database at all, and why the money rules can be
checked without a running server.

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
accountant's call. There is no void or credit-note flow yet.

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

## Documentation

| Document | What it is |
| --- | --- |
| `system_requirements_document.md` | The specification this implements. |
| `docs/renter-onboarding.md` | The operator's runbook: install, the wizard, the daily routine, backups, recovery. |
| `docs/adr/0001-schema-deviations-from-srs.md` | Every place the database departs from SRS §7, and why. |
| `docs/adr/0002-shop-identity-and-vat.md` | Shop identity, VAT and gapless receipt numbering — a requirement the SRS never states. |
| `docs/wongnai-pos-gap-analysis.md` | Where this stands against a commercial Thai POS, and the build order that follows. |

## Not built yet

Deferred deliberately, and listed here rather than discovered during service:

- **Void / refund and credit notes.** The largest *correctness* gap left: receipt
  numbers are gapless and un-reusable and an order can be cancelled, but a
  cancelled tax invoice has no credit-note document behind it.
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
