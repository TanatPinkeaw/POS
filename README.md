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
`src/components/hope/AppShell.tsx`, and dark mode is a `.dark` class on `<html>`
resolved on the server from a cookie so there is no white flash.

---

## Getting started

### 1. PostgreSQL

Needs a running PostgreSQL 17 server. On Windows:

```bash
winget install --id PostgreSQL.PostgreSQL.17 --exact
```

Then create the role and both databases:

```bash
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"
export PGPASSWORD=postgres   # the superuser password you chose at install

psql -U postgres -h localhost -c "CREATE ROLE pos_app LOGIN PASSWORD 'pos_app';"
psql -U postgres -h localhost -c "CREATE DATABASE pos_dev OWNER pos_app;"
psql -U postgres -h localhost -c "CREATE DATABASE pos_test OWNER pos_app;"
```

### 2. Environment

```bash
cp .env.example .env
```

`DATABASE_URL`, `TEST_DATABASE_URL`, and `AUTH_SECRET` are the three that matter.
Tests **refuse to run** unless the test database name contains `test`, because
they truncate tables.

### 3. Install, migrate, seed

```bash
npm install
npm run db:setup        # generate + migrate pos_dev + seed + migrate pos_test
```

The seed prints the demo accounts. The password for all of them is
`password123`.

### 4. Run

```bash
npm run dev             # http://localhost:3000
```

| Role | Phone |
| --- | --- |
| Admin (ผู้จัดการ) | `0800000001` |
| Employee — cashier | `0800000002` |
| Employee — stock | `0800000003` |
| Member | `0900000001` |

---

## Verifying it works

```bash
npm run typecheck       # tsc --noEmit
npm test                # 58 tests: unit + integration
npm run smoke           # 21 end-to-end checks over real HTTP (needs npm run dev)
```

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

`npm run smoke` drives the running server as a browser would — logging in as all
three roles, placing a pre-order, confirming it, collecting it with a PIN, and
reconciling the drawer.

---

## How the SRS maps onto the code

| SRS | Where |
| --- | --- |
| §7 schema | `prisma/schema.prisma` + `prisma/migrations/.../migration.sql` |
| §4.1–4.2 atomic stock | `src/lib/inventory.ts` — one conditional `UPDATE` per mutation |
| §4.3 adjustment audit | `adjustStock()` + `stock_logs` |
| §3 four phases | `src/lib/orders.ts`, pure machine in `src/lib/order-state.ts` |
| §5 loyalty | `src/lib/loyalty.ts` (pure) + `src/lib/points.ts` (ledger) |
| §6.2 cash drawer | `src/lib/shifts.ts` (pure) + `src/lib/cash-shifts.ts` (persistence) |
| §2 RBAC | `src/lib/roles.ts`, enforced in `src/proxy.ts` **and** every route handler |

The domain rules are split into **pure functions** (loyalty, settlement, the
state machine, the discrepancy formula) and **persistence** modules. That split
is why 40 of the tests need no database at all, and why the money rules can be
checked without a running server.

---

## Deliberate deviations and additions

See `docs/adr/0001-schema-deviations-from-srs.md` for the reasoning. In short:

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

## Not built yet

This pass covers the end-to-end vertical slice. Deferred, and not silently:

- **Staff schedules and time tracking** (`work_schedules`, `time_logs`,
  check-in/out). The tables exist and `time_logs.work_hours` is a working stored
  generated column, but there is no UI.
- **Excel exports** (`GET /api/v1/reports/export`) — the SRS §8 four workbooks.
  ExcelJS is installed.
- Void/refund approval flow, product image upload, object storage, RTL support,
  rate limiting, and the audit-log viewer.
