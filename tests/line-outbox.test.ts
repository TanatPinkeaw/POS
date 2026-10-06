// Seam under test: the shop-fact messages the outbox carries (ADR 0030 §3), against
// a real database.
//
// `notify-outbox.test.ts` pins the customer messages' storage; what is new here is
// the *facts*: a refund and a dismissed transfer each write one row, in the same
// transaction as the act, deduped on the thing they name. A fact that queued twice
// would be two alarms for one event, and the group would learn to ignore the
// channel.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { planShopFactMessage, planShopInboundDismissedMessage } from '@/lib/line-notify';
import { enqueueNotification } from '@/lib/notify-outbox';

import { resetDatabase, seedPeople } from './helpers/test-db';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ORDER = '11111111-2222-3333-4444-555555555555';

/** A real order row, because the outbox's foreign key insists on one. */
async function seedOrder(): Promise<string> {
  const order = await prisma.orders.create({
    data: {
      id: ORDER,
      order_number: 'RC-20261006-000001',
      order_type: 'pos_walkin',
      status: 'refunded',
      final_amount: 107,
      net_amount: 100,
      vat_amount: 7,
    },
  });
  return order.id;
}

describe('a refund fact', () => {
  it('queues one row for one refund, whatever the retries', async () => {
    await seedOrder();
    const fact = planShopFactMessage({
      channel: 'line',
      staffTo: 'Cgroup',
      orderId: ORDER,
      orderNumber: 'RC-20261006-000001',
      reason: 'สินค้าชำรุด',
      refundedThb: 107,
    });

    const first = await enqueueNotification(prisma, fact);
    const second = await enqueueNotification(prisma, fact);

    expect(first?.duplicate).toBe(false);
    expect(second?.duplicate).toBe(true);
    expect(await prisma.notifications.count({ where: { kind: 'order_refunded' } })).toBe(1);
  });

  it('queues nothing when the shop configured nothing', async () => {
    await seedOrder();
    const fact = planShopFactMessage({
      channel: null,
      staffTo: null,
      orderId: ORDER,
      orderNumber: 'RC-20261006-000001',
      reason: 'x',
      refundedThb: 1,
    });

    expect(await enqueueNotification(prisma, fact)).toBeNull();
    expect(await prisma.notifications.count()).toBe(0);
  });
});

describe('an inbound-dismissed fact', () => {
  it('queues one row per transfer, keyed by the transfer itself', async () => {
    // No order exists — the fact is about a bank message, and the recipient
    // column is what names it. Two dismissals of the same transfer are one row.
    const fact = planShopInboundDismissedMessage({
      channel: 'line',
      staffTo: 'Cgroup',
      transferId: '4242',
      amountThb: 350,
      reason: 'ไม่ใช่ยอดขาย',
    });

    const first = await enqueueNotification(prisma, fact);
    const second = await enqueueNotification(prisma, fact);

    expect(first?.duplicate).toBe(false);
    expect(second?.duplicate).toBe(true);
    expect(await prisma.notifications.count({ where: { kind: 'inbound_dismissed' } })).toBe(1);

    // A different transfer is a different fact, not a duplicate.
    const other = await enqueueNotification(
      prisma,
      planShopInboundDismissedMessage({
        channel: 'line',
        staffTo: 'Cgroup',
        transferId: '4243',
        amountThb: 90,
        reason: 'ไม่ใช่ยอดขาย',
      }),
    );
    expect(other?.duplicate).toBe(false);
  });

  it('does not collide with an order-keyed message of another kind', async () => {
    // The unique index treats nulls as distinct, so a null-order fact never
    // blocks (or is blocked by) the customer messages beside it.
    await seedOrder();
    const fact = planShopInboundDismissedMessage({
      channel: 'line',
      staffTo: 'Cgroup',
      transferId: ORDER, // Even the same string as an order id must not collide.
      amountThb: 350,
      reason: 'x',
    });

    await expect(enqueueNotification(prisma, fact)).resolves.toMatchObject({ duplicate: false });
  });
});
