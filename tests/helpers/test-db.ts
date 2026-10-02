/**
 * Fixtures for the integration suites.
 *
 * These tests run against a real PostgreSQL database on purpose. The behaviour
 * under test *is* PostgreSQL's row locking, so a mocked client would test the
 * mock rather than the concurrency guarantee.
 */
import { hash } from 'bcryptjs';

import { prisma } from '@/lib/db';
import { SYSTEM_USER_ID, SYSTEM_USER_NAME, SYSTEM_USER_PHONE } from '@/lib/system-user';

/** Every table, most dependent first is unnecessary thanks to CASCADE. */
const TABLES = [
  'audit_logs',
  // Listed explicitly even though CASCADE would reach them: the payment intents
  // and the paired displays are money and authority, and a reset that quietly
  // skipped them would leave a payable QR behind for the next test.
  'payment_intents',
  'display_devices',
  'point_transactions',
  'payments',
  // Listed for the same reason the intents are: a leftover credit note would make
  // the next test's refund look like a double refund, because the guard against
  // one is a unique index on the order it reverses.
  'credit_notes',
  // Cascade from `orders` would reach these too, but they are written *in* the
  // same transactions as orders and a leftover row would make the next test's
  // dedupe assertion pass for the wrong reason.
  'notifications',
  'order_items',
  'orders',
  'stock_logs',
  'time_logs',
  'work_schedules',
  'cash_shifts',
  // Borrowed numbers (ADR 0019) name the user who opened them, and — the real reason to
  // list them — outlive the call that made them: a leftover open block would freeze the
  // next test's series, so a sale there would fail for a reason that has nothing to do
  // with what it was testing.
  'number_blocks',
  'products',
  'categories',
  'users',
  // The shop is a singleton with no dependants, but it must be cleared between
  // tests: a leftover row would make the next test's deployment look configured.
  'shops',
  // The limiter's buckets are rows now (ADR 0012), so they outlive the process that
  // spent them. Without this a suite would inherit the previous run's spent bucket
  // and be refused the request it was about to make.
  'rate_limit_buckets',
  // One live OTP challenge per phone, and it outlives the test that issued it: a
  // leftover row would let the next test find a code it never sent (ADR 0020 §5).
  'otp_challenges',
];

export { prisma };

/** Empties the database and restarts identity sequences. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export interface TestPeople {
  adminId: string;
  employeeId: string;
  memberId: string;
}

/** Creates one user per role plus the system actor. */
export async function seedPeople(): Promise<TestPeople> {
  const passwordHash = await hash('password123', 4);

  await prisma.users.create({
    data: {
      id: SYSTEM_USER_ID,
      phone: SYSTEM_USER_PHONE,
      password_hash: passwordHash,
      full_name: SYSTEM_USER_NAME,
      role: 'admin',
      is_active: false,
    },
  });

  const [admin, employee, member] = await Promise.all([
    prisma.users.create({
      data: { phone: '0800000001', password_hash: passwordHash, full_name: 'ผู้จัดการ', role: 'admin' },
    }),
    prisma.users.create({
      data: { phone: '0800000002', password_hash: passwordHash, full_name: 'แคชเชียร์', role: 'employee' },
    }),
    prisma.users.create({
      data: {
        phone: '0900000001',
        password_hash: passwordHash,
        full_name: 'ลูกค้า',
        role: 'member',
        points_balance: 0,
      },
    }),
  ]);

  return { adminId: admin.id, employeeId: employee.id, memberId: member.id };
}

/** Creates a product with a known starting stock. */
export async function seedProduct(input: {
  name?: string;
  barcode?: string;
  stockQty: number;
  salePrice?: number;
  costPrice?: number;
}): Promise<{ id: string; name: string }> {
  const product = await prisma.products.create({
    data: {
      name: input.name ?? 'สินค้าทดสอบ',
      barcode: input.barcode ?? null,
      stock_qty: input.stockQty,
      reserved_qty: 0,
      sale_price: input.salePrice ?? 100,
      cost_price: input.costPrice ?? 60,
    },
  });
  return { id: product.id, name: product.name };
}

/** Opens a cash drawer for an employee. */
export async function seedOpenShift(employeeId: string, initialCash = 2000): Promise<number> {
  const shift = await prisma.cash_shifts.create({
    data: { opened_by: employeeId, initial_cash: initialCash, status: 'open' },
  });
  return shift.id;
}

/**
 * Creates the one shop row, VAT-registered at the standard rate by default.
 *
 * Returns nothing: tests that care about the values read them back through the
 * same accessor the application uses, which is the point of loading them.
 *
 * `creditNotePrefix` is settable so a suite can prove the credit-note series is
 * the shop's own rather than a constant that happens to look right.
 */
export async function seedShop(
  input: {
    isVatRegistered?: boolean;
    vatRate?: number;
    receiptPrefix?: string;
    creditNotePrefix?: string;
  } = {},
): Promise<void> {
  await prisma.shops.create({
    data: {
      id: 1,
      name: 'ร้านทดสอบ',
      is_vat_registered: input.isVatRegistered ?? true,
      vat_rate: input.vatRate ?? 7,
      prices_include_vat: true,
      receipt_prefix: input.receiptPrefix ?? 'RC',
      credit_note_prefix: input.creditNotePrefix ?? 'CN',
    },
  });
}

/** Reads the shop's two running counters, for a series assertion. */
export async function readSeries(): Promise<{ receipt: bigint; creditNote: bigint }> {
  const shop = await prisma.shops.findUniqueOrThrow({ where: { id: 1 } });
  return {
    receipt: shop.receipt_running_number,
    creditNote: shop.credit_note_running_number,
  };
}

/** Reads the raw counters for a product, bypassing every domain helper. */
export async function readCounters(
  productId: string,
): Promise<{ stockQty: number; reservedQty: number }> {
  const rows = await prisma.$queryRaw<{ stock_qty: number; reserved_qty: number }[]>`
    SELECT "stock_qty", "reserved_qty" FROM "products" WHERE "id" = ${productId}::uuid
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Product ${productId} vanished`);
  }
  return { stockQty: row.stock_qty, reservedQty: row.reserved_qty };
}
