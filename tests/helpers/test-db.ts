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

/**
 * Every application table the reset empties, and the order it must empty them
 * in: a child before every row it points at, because the reset no longer leans
 * on `CASCADE`.
 *
 * This used to be one `TRUNCATE ... RESTART IDENTITY CASCADE`. Measured on the
 * development machine, that costs about 13ms *per table in the list* —
 * PostgreSQL hands each truncated relation a fresh file, and Windows makes
 * creating one expensive — so 24 tables cost ~300ms before a single assertion
 * runs, and the suite paid it once per test. Ordered `DELETE`s are ~10x cheaper
 * and, joined into one statement below, one round trip.
 *
 * `audit_logs` is deliberately absent from this list: a `BEFORE DELETE` trigger
 * refuses to delete a trail row (the 20260104 migration), so `resetDatabase`
 * handles it separately, lifting that trigger just long enough to empty it.
 * `credit_note_items` and `inbound_payments` are listed here even though the old
 * `CASCADE` swept them up implicitly — with `DELETE` there is no cascade, and a
 * table left out now fails loudly instead of silently leaving rows behind for
 * the next test.
 *
 * The ordering is also why this stays an explicit list rather than a catalogue
 * query: the tests that matter most here are for money and authority, and a
 * comment naming why each group is present is worth more than the automation.
 *
 * `audit_logs` is emptied through a guarded `DELETE` rather than a `TRUNCATE`
 * because a `TRUNCATE` bypasses the append-only trigger silently, while lifting
 * the trigger for the length of the reset says out loud what the fixture is
 * doing. `tests/audit.test.ts` proves the trigger is back on afterwards, which
 * is what makes the temporary lift safe.
 */
const TABLES_IN_DELETE_ORDER = [
  // Reached from `credit_notes` and `order_items`; a leftover row would make the
  // next test's refund look like a double refund (unique index on the order it
  // reverses) or corrupt a line's returnable quantity.
  'credit_note_items',
  // Borrowed money that arrived by bank transfer; the intent it matched must be
  // deleted first, so this precedes `payment_intents`.
  'inbound_payments',
  'payment_intents',
  'display_devices',
  'point_transactions',
  // The consignor ledger is money owed to a person, and a leftover row would make
  // the next test's balance wrong rather than merely present (ADR 0023). The payout
  // statements are listed before the ledger rows that point at them.
  'consignor_payables',
  'consignor_payouts',
  'payments',
  // A leftover credit note would make the next test's refund look like a double
  // refund, because the guard against one is a unique index on the order it
  // reverses.
  'credit_notes',
  // Written *in* the same transactions as orders, so a leftover row would make the
  // next test's dedupe assertion pass for the wrong reason.
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

/**
 * The sequences behind the autoincrement columns.
 *
 * They are rewound with a single batched `setval`, because the reset is
 * documented as restarting identity and a suite that assumed "the first drawer
 * is 1" would otherwise quietly start at whatever the previous file left behind.
 */
const IDENTITY_SEQUENCES = [
  'audit_logs_id_seq',
  'cash_shifts_id_seq',
  'categories_id_seq',
  'consignor_payables_id_seq',
  'consignor_payouts_id_seq',
  'credit_note_items_id_seq',
  'display_devices_id_seq',
  'inbound_payments_id_seq',
  'notifications_id_seq',
  'order_items_id_seq',
  'payment_intents_id_seq',
  'payments_id_seq',
  'point_transactions_id_seq',
  'stock_logs_id_seq',
  'time_logs_id_seq',
  'work_schedules_id_seq',
];

export { prisma };

/**
 * Empties the database and restarts identity sequences.
 *
 * The whole thing is one `$executeRawUnsafe`: the pg driver adapter sends an
 * unsafe raw query through the simple query protocol, so the statements travel
 * as one round trip in one implicit transaction. If any of them fails the rest
 * are skipped and the transaction rolls back, which is what a reset wants — a
 * half-empty database would be worse than a loud failure.
 */
export async function resetDatabase(): Promise<void> {
  const statements = [
    // The one table whose own trigger refuses a `DELETE`. It is lifted for the
    // length of this reset — the whole batch is one implicit transaction, so a
    // failure anywhere rolls the lift back and leaves the trail guarded.
    'ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"',
    'DELETE FROM "audit_logs"',
    'ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"',
    ...TABLES_IN_DELETE_ORDER.map((table) => `DELETE FROM "${table}"`),
    `SELECT ${IDENTITY_SEQUENCES.map((seq) => `setval('"${seq}"', 1, false)`).join(', ')}`,
  ];

  await prisma.$executeRawUnsafe(statements.join(';\n'));
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
