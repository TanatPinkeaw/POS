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
  'point_transactions',
  'payments',
  'order_items',
  'orders',
  'stock_logs',
  'time_logs',
  'work_schedules',
  'cash_shifts',
  'products',
  'categories',
  'users',
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
