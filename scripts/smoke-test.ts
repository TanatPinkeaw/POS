/**
 * End-to-end smoke test against a running server.
 *
 * Drives the real HTTP API the way the browser does — signed session cookies,
 * real stock reservations — and asserts the numbers that matter move in the
 * right direction. The unit and integration suites cover behaviour in
 * isolation; this covers the wiring between the proxy, the route handlers, the
 * domain modules, and PostgreSQL.
 *
 * Usage:  npm run dev            (in one terminal)
 *         npm run smoke          (in another)
 */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

// Numeric guard, because a host may set PORT="0" and `"0" || 3000` is truthy.
const basePort = Number(process.env.PORT) || 3000;
const BASE = process.env.SMOKE_BASE_URL ?? `http://localhost:${basePort}`;

/** Demo accounts from the seed. */
const ADMIN = { identifier: '0800000001', password: 'password123' };
const CASHIER = { identifier: '0800000002', password: 'password123' };
const MEMBER = { identifier: '0900000001', password: 'password123' };

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
}

/** Minimal cookie jar: one session per persona. */
class Session {
  private cookie = '';

  async call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      if (pair?.startsWith('pos_session=')) {
        this.cookie = pair;
      }
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 200);
    }

    const envelope = parsed as { data?: T; error?: { message?: string } } | null;
    if (envelope && typeof envelope === 'object' && 'error' in envelope) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} → ${response.status}: ${envelope.error?.message}`,
      );
    }

    return { status: response.status, data: (envelope?.data ?? null) as T };
  }

  async login(credentials: { identifier: string; password: string }): Promise<void> {
    await this.call('/api/v1/auth/login', { method: 'POST', body: credentials });
  }

  /**
   * A raw fetch that keeps the session cookie but does not assume a JSON body.
   * Used for the report export, which answers with a binary workbook.
   */
  raw(path: string): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
      redirect: 'manual',
    });
  }
}

interface ProductDto {
  id: string;
  name: string;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
}

async function findProduct(session: Session, productId?: string): Promise<ProductDto> {
  const { data: products } = await session.call<ProductDto[]>('/api/v1/products');
  const product = productId
    ? products.find((item) => item.id === productId)
    : products.find((item) => item.availableQty >= 5);
  if (!product) {
    throw new Error('No product with enough available stock to smoke test with');
  }
  return product;
}

async function main(): Promise<void> {
  console.log(`Smoke testing ${BASE}\n`);

  const admin = new Session();
  const cashier = new Session();
  const member = new Session();

  console.log('1. Sign in as all three roles');
  await admin.login(ADMIN);
  await cashier.login(CASHIER);
  await member.login(MEMBER);
  const me = await member.call<{ role: string; fullName: string }>('/api/v1/auth/me');
  check('member session resolves to the member account', me.data?.role === 'member', me.data);

  console.log('\n2. The member places a two-unit pre-order (Phase 1)');
  const before = await findProduct(admin);
  const placed = await member.call<{ orderId: string; orderNumber: string; status: string }>(
    '/api/v1/orders',
    { method: 'POST', body: { type: 'preorder', lines: [{ productId: before.id, quantity: 2 }] } },
  );
  check('order is created in Phase 1 pending', placed.data?.status === 'pending', placed.data);

  const reserved = await findProduct(admin, before.id);
  check(
    `reserved_qty rose by 2 (${before.reservedQty} → ${reserved.reservedQty})`,
    reserved.reservedQty === before.reservedQty + 2,
    reserved,
  );
  check(
    `available_qty fell by 2 (${before.availableQty} → ${reserved.availableQty})`,
    reserved.availableQty === before.availableQty - 2,
    reserved,
  );
  check(
    `stock_qty is untouched while reserved (${reserved.stockQty})`,
    reserved.stockQty === before.stockQty,
    reserved,
  );

  console.log('\n3. A member cannot drive the staff phases');
  const forbidden = await member
    .call(`/api/v1/orders/${placed.data.orderId}/confirm`, { method: 'POST', body: {} })
    .then(() => 200)
    .catch((error: Error) => Number(/\b(403)\b/.exec(error.message)?.[1] ?? 0));
  check('confirming as a member is refused with 403', forbidden === 403, forbidden);

  console.log('\n4. The cashier confirms, packs, and the customer gets a PIN (Phase 2 → 3)');
  const confirmed = await cashier.call<{ status: string }>(
    `/api/v1/orders/${placed.data.orderId}/confirm`,
    { method: 'POST', body: {} },
  );
  check('order is confirmed', confirmed.data?.status === 'confirmed', confirmed.data);

  const ready = await cashier.call<{ status: string; pickupPin: string }>(
    `/api/v1/orders/${placed.data.orderId}/ready`,
    { method: 'POST', body: {} },
  );
  check('order is ready for pickup', ready.data?.status === 'ready_for_pickup', ready.data);
  check('a 4-digit pickup PIN was issued', /^\d{4}$/.test(ready.data?.pickupPin ?? ''), ready.data);

  console.log('\n5. Handover lookup by PIN finds the order');
  const lookup = await cashier.call<{ orderNumber: string }>('/api/v1/orders/lookup', {
    method: 'POST',
    body: { pin: ready.data.pickupPin },
  });
  check('PIN lookup returns the same order', lookup.data?.orderNumber === placed.data.orderNumber, lookup.data);

  console.log('\n6. The cashier settles it in cash (Phase 4)');
  // Reuse a drawer left open by an earlier run, so the smoke test is re-runnable.
  const currentShift = await cashier.call<{ shift: { id: number } | null }>('/api/v1/shifts/current');
  let shiftId: number;
  if (currentShift.data?.shift) {
    shiftId = currentShift.data.shift.id;
    check(`reusing the already-open cash drawer #${shiftId}`, true);
  } else {
    const opened = await cashier.call<{ id: number; initialCashThb: number }>(
      '/api/v1/shifts/current',
      { method: 'POST', body: { initialCash: 2000 } },
    );
    shiftId = opened.data.id;
    check('cash drawer opened with a 2,000 THB float', opened.data?.initialCashThb === 2000, opened.data);
  }

  // Two units at the catalogue price; the order froze this price at placement.
  const due = before.salePrice * 2;
  const completed = await cashier.call<{
    status: string;
    changeThb: number;
    pointsEarned: number;
  }>(`/api/v1/orders/${placed.data.orderId}/complete`, {
    method: 'POST',
    body: {
      shiftId,
      // Overpay on purpose so change is exercised.
      settlement: { cash: due, receivedCash: due + 100 },
    },
  });
  check('order is completed', completed.data?.status === 'completed', completed.data);
  check('change is 100 THB', completed.data?.changeThb === 100, completed.data);
  check(
    `loyalty awarded floor(${due} / 3) = ${Math.floor(due / 3)} points`,
    completed.data?.pointsEarned === Math.floor(due / 3),
    completed.data,
  );

  console.log('\n7. The reservation became a real sale');
  const after = await findProduct(admin, before.id);
  check(
    `stock_qty fell by 2 (${before.stockQty} → ${after.stockQty})`,
    after.stockQty === before.stockQty - 2,
    after,
  );
  check(
    `reserved_qty returned to its starting value (${after.reservedQty})`,
    after.reservedQty === before.reservedQty,
    after,
  );

  console.log('\n8. The points ledger recorded the award');
  const meAfter = await member.call<{ pointsBalance: number }>('/api/v1/auth/me');
  check(
    `member balance is now ${meAfter.data?.pointsBalance}`,
    typeof meAfter.data?.pointsBalance === 'number' && meAfter.data.pointsBalance >= Math.floor(due / 3),
    meAfter.data,
  );

  console.log('\n9. An unauthenticated request is turned away');
  const anonymous = new Session();
  const rejected = await anonymous
    .call('/api/v1/products')
    .then(() => 200)
    .catch((error: Error) => Number(/\b(401)\b/.exec(error.message)?.[1] ?? 0));
  check('anonymous API access is refused with 401', rejected === 401, rejected);

  console.log('\n10. The cashier closes the drawer and the cash reconciles');
  // GET returns `{ shift, defaultInitialCashThb }`; only POST returns a bare
  // ShiftSummary. Reading `.id` straight off the GET body would be undefined.
  const drawer = await cashier.call<{
    shift: { id: number; expectedCashThb: number; cashSalesThb: number } | null;
  }>('/api/v1/shifts/current');

  const openShift = drawer.data?.shift;
  check('a cash drawer is open to reconcile', openShift !== null && openShift !== undefined, drawer.data);

  if (!openShift) {
    console.error('\nCannot continue: no open cash drawer.');
    process.exit(1);
  }

  const closed = await cashier.call<{ discrepancyThb: number; discrepancyKind: string }>(
    `/api/v1/shifts/${openShift.id}/close`,
    { method: 'POST', body: { actualCash: openShift.expectedCashThb } },
  );
  check(
    'an exact count reconciles to zero',
    closed.data?.discrepancyThb === 0 && closed.data?.discrepancyKind === 'balanced',
    closed.data,
  );

  console.log('\n11. The admin exports every SRS §8 workbook as a real xlsx');
  const reportTypes = [
    'sales_summary',
    'product_performance',
    'employee_attendance',
    'stock_audit',
  ] as const;
  for (const type of reportTypes) {
    const response = await admin.raw(
      `/api/v1/reports/export?type=${type}&from=2000-01-01&to=2099-12-31`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    // A real .xlsx is a ZIP container, so it must start with the PK\x03\x04 signature.
    const isZip =
      bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    check(`${type}: 200 with the xlsx content type`, response.status === 200 && contentType.includes('spreadsheetml'), contentType);
    check(`${type}: workbook bytes are a ZIP container`, isZip, [...bytes.slice(0, 4)]);
    check(`${type}: non-trivial payload (${bytes.byteLength} bytes)`, bytes.byteLength > 2000);
  }

  console.log('\n12. Exports are admin-only');
  const forbiddenExport = await cashier.raw('/api/v1/reports/export?type=sales_summary');
  check('a cashier is refused with 403', forbiddenExport.status === 403, forbiddenExport.status);

  console.log('\n13. Attendance: the cashier clocks in and out');
  // Leave the clock clean first, so the smoke test is re-runnable.
  const clock = await cashier.call<{ openLog: { logId: number } | null }>(
    '/api/v1/attendance/current',
  );
  if (clock.data?.openLog) {
    check(`closing a log left open by an earlier run (#${clock.data.openLog.logId})`, true);
    await cashier.call('/api/v1/attendance/check-out', { method: 'POST', body: {} });
  }

  const checkedIn = await cashier.call<{
    logId: number;
    checkOut: string | null;
    scheduledStart: string | null;
    workHours: number | null;
  }>('/api/v1/attendance/check-in', { method: 'POST', body: { note: 'smoke' } });
  check('clocking in opens a log', checkedIn.data?.checkOut === null, checkedIn.data);
  check('work_hours is empty while the log is open', checkedIn.data?.workHours === null, checkedIn.data);
  check('the day is matched to the roster for that day', checkedIn.data?.scheduledStart !== undefined, checkedIn.data?.scheduledStart);

  const doubleClockIn = await cashier
    .call('/api/v1/attendance/check-in', { method: 'POST', body: {} })
    .then(() => 200)
    .catch((error: Error) => Number(/\b(409)\b/.exec(error.message)?.[1] ?? 0));
  check('a second clock-in is refused with 409', doubleClockIn === 409, doubleClockIn);

  const checkedOut = await cashier.call<{ workHours: number | null }>(
    '/api/v1/attendance/check-out',
    { method: 'POST', body: {} },
  );
  check(
    'clocking out computes work_hours in the database',
    typeof checkedOut.data?.workHours === 'number',
    checkedOut.data,
  );

  console.log('\n14. The timesheet is admin-only and shows the clock-in');
  const bangkokToday = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const timesheet = await admin.call<{
    rows: { employeePhone: string; employeeId: string; scheduledStart: string | null }[];
  }>(`/api/v1/attendance?from=${bangkokToday}&to=${bangkokToday}`);
  const cashierRow = timesheet.data?.rows.find((row) => row.employeePhone === CASHIER.identifier);
  check('the cashier\u2019s log appears on the admin timesheet', cashierRow !== undefined, timesheet.data?.rows.length);

  const memberTimesheet = await member.raw('/api/v1/attendance');
  check('a member cannot read the timesheet (403)', memberTimesheet.status === 403, memberTimesheet.status);

  console.log('\n15. The roster upserts for the day');
  const savedSchedule = await admin.call<{ id: number; shiftDate: string; startTime: string }>(
    '/api/v1/schedules',
    {
      method: 'POST',
      body: {
        employeeId: cashierRow?.employeeId,
        shiftDate: bangkokToday,
        startTime: '09:00',
        endTime: '17:30',
      },
    },
  );
  check(
    'saving a roster shift round-trips its date and time',
    savedSchedule.data?.shiftDate === bangkokToday && savedSchedule.data?.startTime === '09:00',
    savedSchedule.data,
  );

  const reversedSchedule = await admin
    .call('/api/v1/schedules', {
      method: 'POST',
      body: {
        employeeId: cashierRow?.employeeId,
        shiftDate: bangkokToday,
        startTime: '18:00',
        endTime: '09:00',
      },
    })
    .then(() => 200)
    .catch((error: Error) => Number(/\b(422)\b/.exec(error.message)?.[1] ?? 0));
  check('a shift that ends before it starts is refused with 422', reversedSchedule === 422, reversedSchedule);

  console.log(
    failures === 0
      ? '\nAll smoke checks passed.'
      : `\n${failures} smoke check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('\nSmoke test could not complete:', error);
  process.exit(1);
});
