# ADR 0001 — Where the database differs from SRS §7, and why

**Status:** accepted
**Context:** the SRS specifies both a narrative (its sections) and a concrete DDL
(its §7). The two disagree in several places, and PostgreSQL cannot express a few
of the DDL's requirements in Prisma's schema language.

Every deviation below is one of three kinds: **(a)** the SRS contradicts itself,
and the narrative wins; **(b)** the DDL omits something the narrative requires;
or **(c)** an implementation constraint forced a different spelling of the same
guarantee. Nothing here weakens a guarantee the SRS states.

---

## 1. `gen_random_uuid()` instead of `uuid-ossp`

§7 opens with `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` and uses
`uuid_generate_v4()`.

`gen_random_uuid()` has been in PostgreSQL core since 13 and produces the same
v4 UUIDs. Dropping the extension removes a dependency on an extension package
being present in the server image, which matters for the test database and for
any future managed-Postgres deployment.

**Not a behavioural difference.** Same column type, same uniqueness, same
randomness.

## 2. `stock_logs.reason` — a column the SRS requires but never declares

§4.3: *"When an Employee or Admin updates stock numbers: Requires a mandatory
enum: `REASON_RESTOCK`, `REASON_DAMAGED`, `REASON_EXPIRED`, `REASON_CORRECTION`."*

§7's `stock_logs` table has `movement_type` and `note`, but no column for that
reason. `movement_type` cannot carry it: its enum (`pos_sale`,
`preorder_reserve`, …) describes *what kind of movement* happened, and a
`manual_adjust` says nothing about whether the stock was restocked, damaged,
expired, or corrected.

So `reason stock_adjustment_reason` was added, nullable because system-driven
movements have no human reason, and required by the API whenever a human adjusts
stock.

**Consequence:** `adjustStock()` also derives `movement_type` from the reason
(`REASON_RESTOCK` → `restock`, everything else → `manual_adjust`), so the audit
log stays queryable both ways.

## 3. `orders.pickup_expires_at` — Phase 3's holding window

§3 Phase 3 mandates a holding-time limit ("2–4 hours or by end of business day")
and describes flagging an order `no-show` when it lapses. §7 provides no column
to record when that window closes.

Added as a nullable `TIMESTAMPTZ`, set by `markOrderReady()` from
`PREORDER_HOLD_HOURS`. Nullable because it is meaningless for walk-in sales.

## 4. One `payments` row per leg, not a `mixed` row

§7's `payment_method` enum includes `mixed`. §6.2 then computes:

```
discrepancy = actual − (initial + total cash sales)
```

A single `mixed` row makes "total cash sales" ambiguous: the row's `amount` would
be part cash and part points, and nothing records the split. Reconciling the
drawer would require guessing.

`payments` is already a child table keyed by `order_id`, so the settlement writes
**one row per leg** — a `cash` row, a `promptpay` row, a `points` row. Cash sales
then reduces to `SUM(amount) WHERE method = 'cash'`, exactly the notes in the
drawer. `mixed` stays in the enum (the SRS declares it, and the API still accepts
it as input meaning "split this"), it is just never written.

## 5. A seeded system account owns automated stock movements

§7 declares `stock_logs.changed_by UUID NOT NULL REFERENCES users(id)`.

The Phase 1 timeout expires unconfirmed orders automatically and must release
their stock — which means writing `stock_logs` rows with no human behind them.
The options were to make `changed_by` nullable, or to give automation an
identity.

Making it nullable would put an asterisk on every audit query for the rest of the
project's life. Instead the seed creates a fixed, **inactive** account
(`src/lib/system-user.ts`, `SYSTEM_USER_ID`) that automation reports as. It cannot
be signed into — `is_active = false` and its password is derived from its own UUID
— and its name is explicit in the log ("ระบบอัตโนมัติ (System)").

## 6. `work_hours` lives only in the migration, not in Prisma

§7 declares:

```sql
work_hours NUMERIC(5,2) GENERATED ALWAYS AS (
  ROUND(EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0, 2)
) STORED
```

This is implemented exactly as written. It is deliberately **absent from
`prisma/schema.prisma`**, because Prisma cannot model a generated column and
would attempt to write it on every `INSERT` into `time_logs`.

`work_hours` is therefore read with `$queryRaw` (the timesheet report will need
it). Because the column exists only in hand-written migration SQL, this database
must be maintained with **`prisma migrate deploy`**, never `migrate dev` — the
latter diffs against the Prisma schema and would propose dropping it.

## 7. Hand-written migration section

`prisma migrate diff` emits only tables, indexes, and foreign keys. These were
therefore appended by hand to the initial migration:

- `CHECK (points_balance >= 0)` on `users`
- `CHECK (stock_qty >= 0)`, `CHECK (reserved_qty >= 0)`, and
  `CONSTRAINT chk_stock_availability CHECK (stock_qty >= reserved_qty)` on
  `products` — the SRS's central invariant
- `CHECK (quantity > 0)` on `order_items`
- `CHECK (amount > 0)` on `payments`
- `time_logs.work_hours` (see §6)
- `order_number_seq`, plus two partial indexes

**Why a sequence for order numbers.** Generating `PO-YYYYMMDD-NNNN` by counting
the day's orders is a read-then-write race: two simultaneous checkouts can both
count 41 and both mint `PO-20260101-0042`. `nextval()` is atomic and cannot
collide.

## 8. Indexes

§7 names `idx_products_barcode`. Prisma renders `products.barcode` as
`UNIQUE`, which already creates a unique index on that column; adding a second
index would only cost write throughput. The other named indexes
(`idx_orders_status`, `idx_orders_created_at`, `idx_time_logs_employee`) are
present under Prisma's naming.

Two partial indexes were added beyond §7, both for paths the SRS introduces:

- `idx_orders_pickup_pin` — Phase 4 handover looks an order up by 4-digit PIN.
- `idx_orders_pending_created_at` — the 15-minute sweeper scans only pending
  orders. A partial index keeps that scan proportional to the backlog rather
  than to the order history.

A third partial index arrived with the attendance feature, in its own migration
(`20260102000000_attendance_open_log_unique`) so it applies cleanly to databases
that already have the initial one:

- `ux_time_logs_open_per_employee` — **UNIQUE** on
  `time_logs(employee_id) WHERE check_out IS NULL`. Attendance is a clock you are
  either on or off: two open rows would make `work_hours` meaningless and
  double-count the timesheet, and a double-tapped “clock in” is the obvious way
  to get there. The application returns a readable 409 first, but the index is
  what makes the invariant true for every caller, including a retry racing
  another.
