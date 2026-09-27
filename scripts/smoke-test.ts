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
