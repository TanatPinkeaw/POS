// Seam under test: the customer's own account reads (ADR 0020, ADR 0021).
//
// The property that matters here is scope: a member asking for their points or their
// receipt gets rows that name *them*, and a receipt that names somebody else is a
// refusal. The window is the second property — the customer's download is the one the
// month withholds, even though the shop's reprint is not.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadCustomerReceipt, listCustomerPoints } from '@/lib/customer-portal';
import type { ForbiddenError } from '@/lib/errors';
import { ReceiptWindowClosedError } from '@/lib/receipt-link';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

let memberId: string;
let otherId: string;

beforeEach(async () => {
  await resetDatabase();
  const people = await seedPeople();
  memberId = people.memberId;
  const other = await prisma.users.create({
    data: { phone: '0900000009', password_hash: 'x', full_name: 'ลูกค้าคนอื่น', role: 'member' },
  });
  otherId = other.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Writes a few ledger rows in the order they happened. */
async function seedLedger(
  userId: string,
  entries: { change: number; balance: number; description?: string }[],
): Promise<void> {
  for (const entry of entries) {
    await prisma.point_transactions.create({
      data: {
        user_id: userId,
        points_change: entry.change,
        balance_after: entry.balance,
        description: entry.description ?? null,
      },
    });
  }
}

/** The minimum a completed order needs to render a receipt. */
async function seedCompletedOrder(input: {
  customerId: string;
  number: string;
  completedAt: Date;
}): Promise<{ id: string }> {
  return prisma.orders.create({
    data: {
      order_number: input.number,
      status: 'completed',
      customer_id: input.customerId,
      completed_at: input.completedAt,
      subtotal_amount: 100,
      net_amount: 100,
      final_amount: 100,
      is_vat_invoice: false,
    },
    select: { id: true },
  });
}

describe('the customer points ledger', () => {
  it('returns the balance and only their own entries, newest first', async () => {
    await prisma.users.update({ where: { id: memberId }, data: { points_balance: 42 } });
    await seedLedger(memberId, [
      { change: 10, balance: 10, description: 'ซื้อสินค้า' },
      { change: 32, balance: 42 },
    ]);
    await seedLedger(otherId, [{ change: 99, balance: 99, description: 'ของคนอื่น' }]);

    const page = await listCustomerPoints(memberId);

    expect(page.balance).toBe(42);
    expect(page.entries.map((entry) => entry.pointsChange)).toEqual([32, 10]);
    // Nothing from the other customer's ledger leaked in.
    expect(page.entries.some((entry) => entry.pointsChange === 99)).toBe(false);
  });

  it('reads the balance from the row, not from the window of entries', async () => {
    // A customer with a long history: the newest hundred rows cannot sum to the
    // balance, and a screen that recomputed it would print the wrong number.
    await prisma.users.update({ where: { id: memberId }, data: { points_balance: 500 } });
    await seedLedger(memberId, [{ change: 5, balance: 5 }]);

    expect((await listCustomerPoints(memberId)).balance).toBe(500);
  });

  it('is empty and zero for a customer who has never bought anything', async () => {
    expect(await listCustomerPoints(otherId)).toEqual({ balance: 0, entries: [] });
  });
});

describe('the customer receipt', () => {
  it('serves a customer their own completed order', async () => {
    const order = await seedCompletedOrder({
      customerId: memberId,
      number: 'RC-2026-000001',
      completedAt: new Date(),
    });

    const payload = await loadCustomerReceipt(order.id, memberId);

    expect(payload.receipt.orderNumber).toBe('RC-2026-000001');
  });

  it("refuses another customer's order", async () => {
    const order = await seedCompletedOrder({
      customerId: otherId,
      number: 'RC-2026-000002',
      completedAt: new Date(),
    });

    const failure = (await loadCustomerReceipt(order.id, memberId).catch(
      (error: unknown) => error,
    )) as ForbiddenError;

    expect(failure.code).toBe('FORBIDDEN');
  });

  it('refuses a receipt past the window, while the order still exists', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const order = await seedCompletedOrder({
      customerId: memberId,
      number: 'RC-2026-000003',
      completedAt: old,
    });

    const failure = (await loadCustomerReceipt(order.id, memberId).catch(
      (error: unknown) => error,
    )) as ReceiptWindowClosedError;

    expect(failure.code).toBe('RECEIPT_WINDOW_CLOSED');
    // The window is an access rule, not a deletion: the bill is still there.
    expect(await prisma.orders.findUnique({ where: { id: order.id } })).not.toBeNull();
  });
});
